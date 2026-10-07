/**
 * Per-session ALB routing.
 *
 * These cover the pure naming rule, the no-throw contract and leak prevention.
 * The AWS calls themselves are mocked. A routing failure returns null rather
 * than throwing; the caller treats null as fatal for the session, because there
 * is no shared fallback route (it would land on another tenant's container).
 */
const mockElbSend = jest.fn();

jest.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: jest.fn().mockImplementation(() => ({
    send: mockElbSend,
  })),
  CreateTargetGroupCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'CreateTargetGroup' })),
  CreateRuleCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'CreateRule' })),
  DeleteRuleCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DeleteRule' })),
  DeleteTargetGroupCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DeleteTargetGroup' })),
  DeregisterTargetsCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DeregisterTargets' })),
  DescribeRulesCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DescribeRules' })),
  DescribeTargetGroupsCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DescribeTargetGroups' })),
  DescribeTargetHealthCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DescribeTargetHealth' })),
  DescribeTagsCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DescribeTags' })),
  RegisterTargetsCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'RegisterTargets' })),
}));

// Per-session rules require the CloudFront origin-verify header, read from
// Secrets Manager.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ SecretString: JSON.stringify({ headerValue: 'origin-secret' }) }),
  })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'GetSecretValue' })),
}));

process.env.X_ORIGIN_VERIFY_SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:123:secret:origin';
process.env.SANDBOX_ALB_LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-west-2:123:listener/app/test/abc/def';
process.env.SANDBOX_VPC_ID = 'vpc-test';

import {
  sessionTargetGroupName,
  provisionSessionRouting,
  teardownSessionRouting,
  reconcileOrphanRouting,
} from '../../lib/sandbox/session-manager-lambda/alb-routing';

const SESSION = '3f2a9c1e-7b44-4d8a-9f10-2c6e5b8d1a37';

describe('sessionTargetGroupName', () => {
  it('fits inside the 32-character ELBv2 limit', () => {
    expect(sessionTargetGroupName(SESSION).length).toBeLessThanOrEqual(32);
  });

  it('only uses characters ELBv2 accepts, and does not start or end with a hyphen', () => {
    const name = sessionTargetGroupName(SESSION);
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/);
  });

  it('is deterministic, so a retry reuses the same group instead of duplicating it', () => {
    expect(sessionTargetGroupName(SESSION)).toBe(sessionTargetGroupName(SESSION));
  });

  it('distinguishes different sessions', () => {
    expect(sessionTargetGroupName('session-a')).not.toBe(sessionTargetGroupName('session-b'));
  });
});

describe('provisionSessionRouting', () => {
  beforeEach(() => {
    mockElbSend.mockReset();
  });

  it('creates a target group, registers the container and adds a session rule', async () => {
    const calls: string[] = [];
    const ruleInputs: any[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      calls.push(cmd._type);
      if (cmd._type === 'CreateRule') ruleInputs.push(cmd.input);
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          throw Object.assign(new Error('not found'), { name: 'TargetGroupNotFoundException' });
        case 'CreateTargetGroup':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/session' }] };
        case 'DescribeRules':
          return { Rules: [{ Priority: '10' }] };
        case 'CreateRule':
          return { Rules: [{ RuleArn: 'arn:rule/session' }] };
        default:
          return {};
      }
    });

    const result = await provisionSessionRouting(SESSION, '10.10.2.155');

    expect(result).toEqual({ targetGroupArn: 'arn:tg/session', ruleArn: 'arn:rule/session' });
    expect(calls).toContain('RegisterTargets');
    expect(calls).toContain('CreateRule');
    // Only requests that came through this stack's CloudFront — and so passed its
    // signed-URL check — may be forwarded to the session's container.
    expect(ruleInputs[0].Conditions).toEqual(
      expect.arrayContaining([
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: ['origin-secret'] },
        },
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/ws/*', '/sandbox-preview/*'] } },
      ]),
    );
  });

  it('reuses an existing target group rather than creating a second one', async () => {
    const calls: string[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      calls.push(cmd._type);
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/existing' }] };
        case 'DescribeRules':
          return { Rules: [] };
        case 'CreateRule':
          return { Rules: [{ RuleArn: 'arn:rule/session' }] };
        default:
          return {};
      }
    });

    const result = await provisionSessionRouting(SESSION, '10.10.2.155');

    expect(result?.targetGroupArn).toBe('arn:tg/existing');
    expect(calls).not.toContain('CreateTargetGroup');
  });

  it('retries on a priority collision, since two Lambdas can pick the same slot', async () => {
    let createRuleAttempts = 0;
    mockElbSend.mockImplementation((cmd: any) => {
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/existing' }] };
        case 'DescribeRules':
          return { Rules: [] };
        case 'CreateRule':
          createRuleAttempts++;
          if (createRuleAttempts === 1) {
            throw Object.assign(new Error('taken'), { name: 'PriorityInUse' });
          }
          return { Rules: [{ RuleArn: 'arn:rule/second-try' }] };
        default:
          return {};
      }
    });

    const result = await provisionSessionRouting(SESSION, '10.10.2.155');

    expect(createRuleAttempts).toBe(2);
    expect(result?.ruleArn).toBe('arn:rule/second-try');
  });

  it('returns null instead of throwing when AWS fails, so the caller can fail the claim cleanly', async () => {
    mockElbSend.mockImplementation(() => {
      throw new Error('AccessDenied');
    });

    await expect(provisionSessionRouting(SESSION, '10.10.2.155')).resolves.toBeNull();
  });

  it('drops a previously pinned container when re-pinning', async () => {
    let deregistered: any[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/existing' }] };
        case 'DescribeTargetHealth':
          // The session was pinned to an older container before this call.
          return {
            TargetHealthDescriptions: [
              { Target: { Id: '10.10.9.9', Port: 8080 } },
              { Target: { Id: '10.10.2.155', Port: 8080 } },
            ],
          };
        case 'DeregisterTargets':
          deregistered = cmd.input.Targets;
          return {};
        case 'DescribeRules':
          return { Rules: [] };
        case 'CreateRule':
          return { Rules: [{ RuleArn: 'arn:rule/session' }] };
        default:
          return {};
      }
    });

    await provisionSessionRouting(SESSION, '10.10.2.155');

    // Leaving the stale target registered would put the group back to balancing
    // across two containers — the exact problem this routing exists to remove.
    expect(deregistered).toEqual([{ Id: '10.10.9.9', Port: 8080 }]);
  });

  it('reuses the session rule when re-pinning, rather than consuming another priority', async () => {
    let createRuleCalls = 0;
    mockElbSend.mockImplementation((cmd: any) => {
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/existing' }] };
        case 'DescribeTargetHealth':
          return { TargetHealthDescriptions: [{ Target: { Id: '10.10.2.155', Port: 8080 } }] };
        case 'DescribeRules':
          return {
            Rules: [
              {
                RuleArn: 'arn:rule/already-there',
                Priority: '1000',
                Conditions: [
                  { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-sandbox-session', Values: [SESSION] } },
                  { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: ['origin-secret'] } },
                  { Field: 'path-pattern', PathPatternConfig: { Values: ['/ws/*', '/sandbox-preview/*'] } },
                ],
              },
            ],
          };
        case 'CreateRule':
          createRuleCalls++;
          return { Rules: [{ RuleArn: 'arn:rule/new' }] };
        default:
          return {};
      }
    });

    const result = await provisionSessionRouting(SESSION, '10.10.2.155');

    expect(createRuleCalls).toBe(0);
    expect(result?.ruleArn).toBe('arn:rule/already-there');
  });

  it('replaces a rule created before the origin-verify and path conditions existed', async () => {
    // A header-only rule forwards any path carrying the session header, including
    // ones CloudFront does not require a signature for — so it must not survive.
    const calls: string[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      calls.push(cmd._type);
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/existing' }] };
        case 'DescribeTargetHealth':
          return { TargetHealthDescriptions: [] };
        case 'DescribeRules':
          return {
            Rules: [
              { RuleArn: 'arn:rule/legacy', Priority: '100', Conditions: [{ HttpHeaderConfig: { Values: [SESSION] } }] },
            ],
          };
        case 'CreateRule':
          return { Rules: [{ RuleArn: 'arn:rule/new' }] };
        default:
          return {};
      }
    });

    const result = await provisionSessionRouting(SESSION, '10.10.2.155');

    expect(calls.indexOf('DeleteRule')).toBeGreaterThan(-1);
    expect(calls.indexOf('DeleteRule')).toBeLessThan(calls.indexOf('CreateRule'));
    expect(result?.ruleArn).toBe('arn:rule/new');
  });
});

describe('teardownSessionRouting', () => {
  beforeEach(() => {
    mockElbSend.mockReset();
  });

  it('deletes the session rule before its target group', async () => {
    const calls: string[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      calls.push(cmd._type);
      switch (cmd._type) {
        case 'DescribeRules':
          return {
            Rules: [
              {
                RuleArn: 'arn:rule/session',
                Conditions: [{ HttpHeaderConfig: { Values: [SESSION] } }],
              },
            ],
          };
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/session' }] };
        default:
          return {};
      }
    });

    await teardownSessionRouting(SESSION);

    // A target group still referenced by a rule cannot be deleted.
    expect(calls.indexOf('DeleteRule')).toBeLessThan(calls.indexOf('DeleteTargetGroup'));
  });

  it('leaves another session rule alone', async () => {
    const deleted: string[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'DescribeRules') {
        return {
          Rules: [
            { RuleArn: 'arn:rule/other', Conditions: [{ HttpHeaderConfig: { Values: ['someone-else'] } }] },
          ],
        };
      }
      if (cmd._type === 'DeleteRule') {
        deleted.push(cmd.input.RuleArn);
      }
      if (cmd._type === 'DescribeTargetGroups') {
        throw Object.assign(new Error('not found'), { name: 'TargetGroupNotFoundException' });
      }
      return {};
    });

    await teardownSessionRouting(SESSION);

    expect(deleted).toEqual([]);
  });

  it('never throws, so a cleanup failure cannot fail the caller', async () => {
    mockElbSend.mockImplementation(() => {
      throw new Error('Throttled');
    });

    await expect(teardownSessionRouting(SESSION)).resolves.toBeUndefined();
  });
});

/**
 * Rule-leak fixes (prod hit the 100-rule listener quota and sessions fell
 * through to the shared route).
 */
describe('routing leak prevention', () => {
  beforeEach(() => {
    mockElbSend.mockReset();
  });

  it('teardown follows DescribeRules pagination to find a rule on a later page', async () => {
    const deleted: string[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      switch (cmd._type) {
        case 'DescribeRules':
          if (!cmd.input.Marker) {
            return {
              Rules: [{ RuleArn: 'arn:rule/other', Conditions: [{ HttpHeaderConfig: { Values: ['someone-else'] } }] }],
              NextMarker: 'page-2',
            };
          }
          return { Rules: [{ RuleArn: 'arn:rule/session', Conditions: [{ HttpHeaderConfig: { Values: [SESSION] } }] }] };
        case 'DeleteRule':
          deleted.push(cmd.input.RuleArn);
          return {};
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/session' }] };
        default:
          return {};
      }
    });

    await teardownSessionRouting(SESSION);

    expect(deleted).toEqual(['arn:rule/session']);
  });

  it('deletes the target group it created when CreateRule fails', async () => {
    const calls: string[] = [];
    mockElbSend.mockImplementation((cmd: any) => {
      calls.push(cmd._type);
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          throw Object.assign(new Error('not found'), { name: 'TargetGroupNotFoundException' });
        case 'CreateTargetGroup':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/session' }] };
        case 'DescribeRules':
          return { Rules: [] };
        case 'CreateRule':
          throw Object.assign(new Error('quota'), { name: 'TooManyRules' });
        default:
          return {};
      }
    });

    await expect(provisionSessionRouting(SESSION, '10.10.2.155')).resolves.toBeNull();
    expect(calls).toContain('DeleteTargetGroup');
  });

  it('deletes the target group when no rule priority is free', async () => {
    const calls: string[] = [];
    const full = Array.from({ length: 701 }, (_, i) => ({ Priority: String(100 + i) }));
    mockElbSend.mockImplementation((cmd: any) => {
      calls.push(cmd._type);
      switch (cmd._type) {
        case 'DescribeTargetGroups':
          return { TargetGroups: [{ TargetGroupArn: 'arn:tg/session' }] };
        case 'DescribeRules':
          return { Rules: full };
        default:
          return {};
      }
    });

    await expect(provisionSessionRouting(SESSION, '10.10.2.155')).resolves.toBeNull();
    expect(calls).toContain('DeleteTargetGroup');
  });
});

describe('reconcileOrphanRouting', () => {
  const LIVE = 'live-session';
  const GONE = 'gone-session';
  const STALE = 'stopped-long-ago';

  const sessionRule = (sessionId: string, priority: string) => ({
    RuleArn: `arn:rule/${sessionId}`,
    Priority: priority,
    IsDefault: false,
    Conditions: [
      { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-sandbox-session', Values: [sessionId] } },
      { Field: 'path-pattern', PathPatternConfig: { Values: ['/ws/*', '/sandbox-preview/*'] } },
    ],
    Actions: [{ Type: 'forward', TargetGroupArn: `arn:aws:elasticloadbalancing:us-west-2:123:targetgroup/sbx-s-${sessionId}/1` }],
  });

  const staticRules = [
    { RuleArn: 'arn:rule/default', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'fixed-response' }] },
    {
      RuleArn: 'arn:rule/preview-20',
      Priority: '20',
      IsDefault: false,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/sandbox-preview/*'] } }],
      Actions: [{ Type: 'forward', TargetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:123:targetgroup/bd-vibe-sbx-sidecar/1' }],
    },
    {
      RuleArn: 'arn:rule/ws-900',
      Priority: '900',
      IsDefault: false,
      // Even a static rule carrying a session header condition is never touched.
      Conditions: [{ Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-sandbox-session', Values: [GONE] } }],
      Actions: [{ Type: 'forward', TargetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:123:targetgroup/sbx-s-gone/1' }],
    },
  ];

  const tg = (sessionId: string, managedBy = 'bd-vibe-session-manager', lbs: string[] = []) => ({
    TargetGroupArn: `arn:tg/sbx-s-${sessionId}`,
    TargetGroupName: `sbx-s-${sessionId}`.slice(0, 32),
    LoadBalancerArns: lbs,
    _tags: [
      { Key: 'ManagedBy', Value: managedBy },
      { Key: 'SessionId', Value: sessionId },
    ],
  });

  function mockListener(groups: ReturnType<typeof tg>[], deletedRules: string[], deletedGroups: string[]) {
    mockElbSend.mockImplementation((cmd: any) => {
      switch (cmd._type) {
        case 'DescribeRules':
          return {
            Rules: [...staticRules, sessionRule(LIVE, '100'), sessionRule(GONE, '101'), sessionRule(STALE, '102')],
          };
        case 'DeleteRule':
          deletedRules.push(cmd.input.RuleArn);
          return {};
        case 'DescribeTargetGroups':
          return { TargetGroups: groups.map(({ _tags, ...g }) => g) };
        case 'DescribeTags':
          return {
            TagDescriptions: (cmd.input.ResourceArns as string[]).map((arn) => ({
              ResourceArn: arn,
              Tags: groups.find((g) => g.TargetGroupArn === arn)?._tags ?? [],
            })),
          };
        case 'DeleteTargetGroup':
          deletedGroups.push(cmd.input.TargetGroupArn);
          return {};
        default:
          return {};
      }
    });
  }

  const isOrphan = async (sessionId: string) => sessionId !== LIVE;

  it('deletes per-session rules whose session is gone and leaves live and static rules alone', async () => {
    const deletedRules: string[] = [];
    mockListener([], deletedRules, []);

    const result = await reconcileOrphanRouting(isOrphan);

    expect(deletedRules.sort()).toEqual([`arn:rule/${GONE}`, `arn:rule/${STALE}`].sort());
    expect(deletedRules).not.toContain('arn:rule/default');
    expect(deletedRules).not.toContain('arn:rule/preview-20');
    expect(deletedRules).not.toContain('arn:rule/ws-900');
    // Session rules on the listener before this run's deletions.
    expect(result.sessionRuleCount).toBe(3);
    expect(result.deletedRules).toBe(2);
  });

  it('deletes orphan session target groups this stack manages, and nothing else', async () => {
    const deletedGroups: string[] = [];
    mockListener(
      [tg(LIVE), tg(GONE), tg('foreign-stack', 'other-stack-session-manager'), tg('in-use', 'bd-vibe-session-manager', ['arn:lb'])],
      [],
      deletedGroups,
    );

    await reconcileOrphanRouting(isOrphan);

    expect(deletedGroups).toEqual([`arn:tg/sbx-s-${GONE}`]);
  });

  it('caps deletions per run', async () => {
    const deletedRules: string[] = [];
    mockListener([], deletedRules, []);

    await reconcileOrphanRouting(isOrphan, { maxDeletions: 1 });

    expect(deletedRules).toHaveLength(1);
  });

  it('never throws, so the cleanup cron keeps running', async () => {
    mockElbSend.mockImplementation(() => {
      throw new Error('Throttled');
    });

    await expect(reconcileOrphanRouting(isOrphan)).resolves.toEqual(
      expect.objectContaining({ deletedRules: 0 }),
    );
  });
});
