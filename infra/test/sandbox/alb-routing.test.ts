/**
 * Per-session ALB routing.
 *
 * These cover the pure naming rule and the fail-soft contract. The AWS calls
 * themselves are mocked: what matters is that a routing failure never breaks
 * session creation, because a session with no rule of its own still works via
 * the static catch-all route.
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
  taskIpFromContainerId,
} from '../../lib/sandbox/session-manager-lambda/alb-routing';

const SESSION = '3f2a9c1e-7b44-4d8a-9f10-2c6e5b8d1a37';

/**
 * The container is the authority on which box is serving a session — claiming a
 * warm task never tells the container about it — so its reported hostname is
 * translated back into the address the load balancer targets.
 */
describe('taskIpFromContainerId', () => {
  it('reads the task ip out of an awsvpc hostname', () => {
    expect(taskIpFromContainerId('ip-10-10-2-155.us-west-2.compute.internal')).toBe('10.10.2.155');
  });

  it('handles single-digit octets', () => {
    expect(taskIpFromContainerId('ip-10-0-1-7.eu-west-1.compute.internal')).toBe('10.0.1.7');
  });

  it('returns null for a hostname that is not in that form', () => {
    expect(taskIpFromContainerId('unknown')).toBeNull();
    expect(taskIpFromContainerId('some-container-abc123')).toBeNull();
    expect(taskIpFromContainerId(undefined)).toBeNull();
    expect(taskIpFromContainerId('')).toBeNull();
  });

  it('rejects octets outside the valid range rather than pinning a bogus address', () => {
    expect(taskIpFromContainerId('ip-10-10-2-999.us-west-2.compute.internal')).toBeNull();
    expect(taskIpFromContainerId('ip-300-1-1-1.us-west-2.compute.internal')).toBeNull();
  });
});

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

  it('returns null instead of throwing when AWS fails, so session creation survives', async () => {
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
