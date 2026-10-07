import {
  ElasticLoadBalancingV2Client,
  CreateTargetGroupCommand,
  CreateRuleCommand,
  DeleteRuleCommand,
  DeleteTargetGroupCommand,
  DeregisterTargetsCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeTagsCommand,
  RegisterTargetsCommand,
  type Rule,
  type TargetGroup,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { createHash } from 'node:crypto';

const client = new ElasticLoadBalancingV2Client({});

const LISTENER_ARN = process.env.SANDBOX_ALB_LISTENER_ARN || '';
const VPC_ID = process.env.SANDBOX_VPC_ID || '';
const STACK_PREFIX = process.env.STACK_PREFIX || 'bd-vibe';
const ORIGIN_VERIFY_SECRET_ARN = process.env.X_ORIGIN_VERIFY_SECRET_ARN || '';

let cachedOriginVerify: string | null = null;

/**
 * The `X-Origin-Verify` value CloudFront sends to the sandbox ALB.
 *
 * Every forwarding rule on the listener requires it — the static ones are given
 * it by CloudFormation (sandbox-alb.ts) and the per-session ones get it here — so
 * a request that did not come through this stack's CloudFront, and therefore did
 * not pass its signed-URL check, is never forwarded to a container.
 */
async function getOriginVerifyValue(): Promise<string> {
  if (cachedOriginVerify) {
    return cachedOriginVerify;
  }

  if (!ORIGIN_VERIFY_SECRET_ARN) {
    throw new Error('X_ORIGIN_VERIFY_SECRET_ARN is not configured');
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const result = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: ORIGIN_VERIFY_SECRET_ARN }),
  );
  const value = (JSON.parse(result.SecretString ?? '{}') as { headerValue?: string }).headerValue;

  if (!value) {
    throw new Error('Origin-verify secret has no headerValue');
  }

  cachedOriginVerify = value;
  return value;
}

/**
 * Per-session rules live in this band, below the static fail-closed `/ws/*` and
 * `/sandbox-preview/*` rules at 900+ (see sandbox-alb.ts).
 *
 * ALB walks rules in ascending priority and stops at the first match, so a lower
 * number wins.
 */
const PRIORITY_BASE = 100;
/**
 * Upper bound of the per-session band. The real ceiling is the listener's rule
 * quota (100 by default), which is why leaked rules are reconciled away and
 * `SessionRuleCount` is alarmed on. Exhaustion is fatal for the new session — it
 * gets no container — because the static rules return 503 rather than
 * forwarding to an arbitrary, possibly another tenant's, container.
 */
const PRIORITY_LIMIT = 800;

/** Header CloudFront lifts out of `/ws/{id}` and `/sandbox-preview/{id}/`. */
const SESSION_HEADER = 'x-sandbox-session';

/** Prefix of every per-session target group name; see {@link sessionTargetGroupName}. */
const SESSION_TG_PREFIX = 'sbx-s-';

/** `ManagedBy` tag value on target groups this stack's session manager creates. */
function managedByTag(): string {
  return `${STACK_PREFIX}-session-manager`;
}

/**
 * A session's routing: the target group holding its container and the listener
 * rule that steers the session's traffic there.
 */
export interface SessionRouting {
  targetGroupArn: string;
  ruleArn: string;
}

/**
 * Target-group name for a session.
 *
 * ELBv2 caps names at 32 characters (alphanumerics and hyphens, no leading or
 * trailing hyphen), and a session id is already a 36-character UUID, so the id
 * cannot appear verbatim. A truncated hash keeps the name deterministic — the
 * same session always maps to the same name, so a retry finds the existing group
 * instead of creating a duplicate — while staying inside the limit.
 */
export function sessionTargetGroupName(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return `${SESSION_TG_PREFIX}${digest}`;
}

/**
 * Route a session's WebSocket traffic to the container serving it.
 *
 * `/ws/*` is load-balanced across the whole warm pool and the only affinity is a
 * per-browser stickiness cookie, so a second browser opening the same session
 * lands on an arbitrary container. Matching on the session — which every
 * collaborator's URL carries — is what puts them all on the same one.
 *
 * Safe to call again for a session that already has routing: the target group is
 * reused and its membership is replaced, so re-pinning to a different container
 * (for example once the owner's connection reveals which box actually answered)
 * converges rather than accumulating targets.
 *
 * Returns null when routing could not be provisioned. Callers must treat that as
 * fatal for the session: there is no shared fallback route any more, so a
 * session without its own rule cannot reach a container (by design — the
 * fallback used to land it on an arbitrary one). Any target group created here
 * is deleted again on failure so it does not leak.
 */
export async function provisionSessionRouting(
  sessionId: string,
  privateIp: string,
): Promise<SessionRouting | null> {
  console.log(`[alb-routing] provisionSessionRouting called: session=${sessionId} ip=${privateIp} listener=${LISTENER_ARN ? 'set' : 'MISSING'} vpc=${VPC_ID ? 'set' : 'MISSING'}`);
  if (!LISTENER_ARN || !VPC_ID) {
    console.warn('[alb-routing] Listener or VPC not configured — skipping session routing');
    return null;
  }

  let targetGroupArn: string | null = null;

  try {
    targetGroupArn = await ensureTargetGroup(sessionId);

    await client.send(
      new RegisterTargetsCommand({
        TargetGroupArn: targetGroupArn,
        Targets: [{ Id: privateIp, Port: 8080 }],
      }),
    );

    // Drop any container this session was previously pinned to. Re-pinning is
    // normal — the claim is a guess until a container answers — and leaving the
    // old target registered would put the group back to load-balancing between
    // two boxes, which is the problem this exists to solve.
    await deregisterOtherTargets(targetGroupArn, privateIp);

    const ruleArn = await ensureSessionRule(sessionId, targetGroupArn);

    if (!ruleArn) {
      await deleteTargetGroupQuietly(targetGroupArn);
      return null;
    }

    console.log(`[alb-routing] Pinned session ${sessionId} to ${privateIp}`);

    return { targetGroupArn, ruleArn };
  } catch (err) {
    console.error(`[alb-routing] Failed to provision routing for ${sessionId}:`, err);

    // No rule forwards to the group if we got here without one, so it is safe to
    // drop; leaving it would leak a target group per failed claim.
    if (targetGroupArn) {
      await deleteTargetGroupQuietly(targetGroupArn);
    }

    return null;
  }
}

async function deleteTargetGroupQuietly(targetGroupArn: string): Promise<void> {
  try {
    await client.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroupArn }));
  } catch (err) {
    console.warn(`[alb-routing] Could not delete target group ${targetGroupArn}:`, err);
  }
}

/** Every rule on the listener, following pagination. */
async function listAllRules(): Promise<Rule[]> {
  const rules: Rule[] = [];
  let marker: string | undefined;

  do {
    const page = await client.send(
      new DescribeRulesCommand({ ListenerArn: LISTENER_ARN, Marker: marker }),
    );
    rules.push(...(page.Rules ?? []));
    marker = page.NextMarker;
  } while (marker);

  return rules;
}

/** Remove every target except the one this session is now pinned to. */
async function deregisterOtherTargets(targetGroupArn: string, keepIp: string): Promise<void> {
  const health = await client.send(
    new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }),
  );

  const stale = (health.TargetHealthDescriptions ?? [])
    .map((description) => description.Target)
    .filter((target): target is { Id: string; Port: number } =>
      Boolean(target?.Id && target.Id !== keepIp),
    );

  if (stale.length === 0) {
    return;
  }

  await client.send(
    new DeregisterTargetsCommand({
      TargetGroupArn: targetGroupArn,
      Targets: stale.map((target) => ({ Id: target.Id, Port: target.Port })),
    }),
  );
}

/**
 * Reuse the session's target group if it already exists, so a retried or
 * reconnecting session does not accumulate duplicates.
 */
async function ensureTargetGroup(sessionId: string): Promise<string> {
  const name = sessionTargetGroupName(sessionId);

  try {
    const existing = await client.send(new DescribeTargetGroupsCommand({ Names: [name] }));
    const arn = existing.TargetGroups?.[0]?.TargetGroupArn;
    if (arn) {
      return arn;
    }
  } catch {
    // TargetGroupNotFound is the expected path for a new session.
  }

  const created = await client.send(
    new CreateTargetGroupCommand({
      Name: name,
      VpcId: VPC_ID,
      Protocol: 'HTTP',
      Port: 8080,
      TargetType: 'ip',
      HealthCheckProtocol: 'HTTP',
      HealthCheckPort: '8080',
      HealthCheckPath: '/',
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
      Tags: [
        { Key: 'ManagedBy', Value: managedByTag() },
        { Key: 'SessionId', Value: sessionId },
      ],
    }),
  );

  const arn = created.TargetGroups?.[0]?.TargetGroupArn;

  if (!arn) {
    throw new Error('CreateTargetGroup returned no ARN');
  }

  return arn;
}

/**
 * The listener rule for a session, matching the session id that CloudFront lifts
 * out of the `/ws/{sessionId}` path into a header. Reuses the session's existing
 * rule if it has one, so re-pinning does not consume a second priority slot.
 */
async function ensureSessionRule(
  sessionId: string,
  targetGroupArn: string,
): Promise<string | null> {
  const existing = await findSessionRule(sessionId);

  if (existing?.current) {
    return existing.arn;
  }

  // A rule created before the current conditions (path scope and CloudFront
  // origin-verify) would still forward header-only requests, so replace it
  // rather than keep routing through it.
  if (existing) {
    console.log(`[alb-routing] Replacing outdated rule for ${sessionId}`);
    await client.send(new DeleteRuleCommand({ RuleArn: existing.arn }));
  }

  return createSessionRule(sessionId, targetGroupArn);
}

/** Paths a session's rule forwards: its socket and its preview, nothing else. */
const SESSION_RULE_PATHS = ['/ws/*', '/sandbox-preview/*'];

/** This session's listener rule, if one exists, and whether it has today's conditions. */
async function findSessionRule(
  sessionId: string,
): Promise<{ arn: string; current: boolean } | null> {
  let marker: string | undefined;

  do {
    const page = await client.send(
      new DescribeRulesCommand({ ListenerArn: LISTENER_ARN, Marker: marker }),
    );

    for (const rule of page.Rules ?? []) {
      const matches = rule.Conditions?.some((condition) =>
        condition.HttpHeaderConfig?.Values?.includes(sessionId),
      );

      if (matches && rule.RuleArn) {
        const current =
          Boolean(rule.Conditions?.some((c) => c.HttpHeaderConfig?.HttpHeaderName === 'X-Origin-Verify')) &&
          Boolean(rule.Conditions?.some((c) => c.Field === 'path-pattern'));

        return { arn: rule.RuleArn, current };
      }
    }

    marker = page.NextMarker;
  } while (marker);

  return null;
}

/**
 * Create the listener rule for a session.
 *
 * Priorities must be unique per listener and two Lambdas can pick the same free
 * slot concurrently, so a collision is retried against a freshly-read set rather
 * than treated as an error.
 */
async function createSessionRule(
  sessionId: string,
  targetGroupArn: string,
): Promise<string | null> {
  const MAX_ATTEMPTS = 5;
  const originVerify = await getOriginVerifyValue();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const priority = await nextFreePriority();

    if (priority === null) {
      console.warn(`[alb-routing] No free rule priority for ${sessionId} — session cannot be routed`);
      return null;
    }

    try {
      const created = await client.send(
        new CreateRuleCommand({
          ListenerArn: LISTENER_ARN,
          Priority: priority,
          Conditions: [
            {
              Field: 'http-header',
              HttpHeaderConfig: {
                HttpHeaderName: SESSION_HEADER,
                Values: [sessionId],
              },
            },
            {
              Field: 'http-header',
              HttpHeaderConfig: {
                HttpHeaderName: 'X-Origin-Verify',
                Values: [originVerify],
              },
            },
            // Without a path scope the rule would forward any path carrying the
            // session header — including ones CloudFront does not require a
            // signature for.
            {
              Field: 'path-pattern',
              PathPatternConfig: { Values: SESSION_RULE_PATHS },
            },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
          Tags: [{ Key: 'SessionId', Value: sessionId }],
        }),
      );

      const arn = created.Rules?.[0]?.RuleArn;
      if (arn) {
        return arn;
      }
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'PriorityInUse' && attempt < MAX_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }

  return null;
}

/** Lowest unused priority in the per-session band, or null when it is full. */
async function nextFreePriority(): Promise<number | null> {
  const taken = new Set<number>();
  let marker: string | undefined;

  do {
    const page = await client.send(
      new DescribeRulesCommand({ ListenerArn: LISTENER_ARN, Marker: marker }),
    );

    for (const rule of page.Rules ?? []) {
      const priority = Number(rule.Priority);
      if (!Number.isNaN(priority)) {
        taken.add(priority);
      }
    }

    marker = page.NextMarker;
  } while (marker);

  for (let priority = PRIORITY_BASE; priority <= PRIORITY_LIMIT; priority++) {
    if (!taken.has(priority)) {
      return priority;
    }
  }

  return null;
}

/**
 * Remove a session's routing so its priority slot and target group are freed for
 * the next session. Best effort: a leaked rule would eventually exhaust the band,
 * but failing to clean up must not fail the caller's request.
 */
export async function teardownSessionRouting(sessionId: string): Promise<void> {
  if (!LISTENER_ARN) {
    return;
  }

  try {
    // Paginated: an unpaginated read missed rules past the first page, which is
    // one way rules leaked until the listener hit its quota.
    const rules = await listAllRules();

    for (const rule of rules) {
      const matchesSession = rule.Conditions?.some((condition) =>
        condition.HttpHeaderConfig?.Values?.includes(sessionId),
      );

      if (matchesSession && rule.RuleArn) {
        await client.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }));
      }
    }

    // The rule must be gone before the group it forwards to can be deleted.
    const name = sessionTargetGroupName(sessionId);
    const groups = await client.send(new DescribeTargetGroupsCommand({ Names: [name] }));
    const arn = groups.TargetGroups?.[0]?.TargetGroupArn;

    if (arn) {
      await client.send(new DeleteTargetGroupCommand({ TargetGroupArn: arn }));
    }

    console.log(`[alb-routing] Released routing for session ${sessionId}`);
  } catch (err) {
    console.warn(`[alb-routing] Failed to tear down routing for ${sessionId}:`, err);
  }
}

export interface ReconcileResult {
  /** Per-session rules on the listener at the start of the run. */
  sessionRuleCount: number;
  deletedRules: number;
  deletedTargetGroups: number;
}

export interface ReconcileOptions {
  /** Upper bound on rules plus target groups deleted in one run. */
  maxDeletions?: number;
}

/** Target group a rule forwards to, from either action shape ELBv2 returns. */
function forwardTargetGroups(rule: Rule): string[] {
  return (rule.Actions ?? []).flatMap((action) => [
    ...(action.TargetGroupArn ? [action.TargetGroupArn] : []),
    ...(action.ForwardConfig?.TargetGroups ?? []).flatMap((tg) => (tg.TargetGroupArn ? [tg.TargetGroupArn] : [])),
  ]);
}

/**
 * The session a rule was created for, or null if it is not a per-session rule.
 *
 * Deliberately narrow, because anything this returns non-null for may be
 * deleted: never the default rule, never a static rule outside the per-session
 * priority band (20, 900, ...), and only rules that match exactly one session
 * header value and forward to a per-session target group.
 */
function sessionOfRule(rule: Rule): string | null {
  if (rule.IsDefault) {
    return null;
  }

  const priority = Number(rule.Priority);
  if (!Number.isInteger(priority) || priority < PRIORITY_BASE || priority > PRIORITY_LIMIT) {
    return null;
  }

  const header = rule.Conditions?.find(
    (c) => c.HttpHeaderConfig?.HttpHeaderName?.toLowerCase() === SESSION_HEADER,
  );
  const values = header?.HttpHeaderConfig?.Values ?? [];
  if (values.length !== 1) {
    return null;
  }

  const forwardsToSessionGroup = forwardTargetGroups(rule).some((arn) =>
    arn.includes(`:targetgroup/${SESSION_TG_PREFIX}`),
  );

  return forwardsToSessionGroup ? values[0] : null;
}

async function listSessionTargetGroups(): Promise<TargetGroup[]> {
  const groups: TargetGroup[] = [];
  let marker: string | undefined;

  do {
    const page = await client.send(new DescribeTargetGroupsCommand({ Marker: marker }));
    groups.push(...(page.TargetGroups ?? []).filter((g) => g.TargetGroupName?.startsWith(SESSION_TG_PREFIX)));
    marker = page.NextMarker;
  } while (marker);

  return groups;
}

/**
 * Delete per-session routing whose session no longer needs it.
 *
 * Teardown on session end is best effort, and in the past sessions also vanished
 * without one (TTL deletion of the record, crashes between claim and teardown),
 * so leaked rules accumulated until the listener hit its rule quota. This sweeps
 * them up: per-session rules first, then this stack's (`ManagedBy`-tagged)
 * per-session target groups that no rule forwards to any more.
 *
 * `isOrphan` decides per session id (the caller knows the session store). Capped
 * per run so a bad answer cannot wipe the listener in one go, and it never
 * throws, so the cleanup cron always finishes.
 */
export async function reconcileOrphanRouting(
  isOrphan: (sessionId: string) => Promise<boolean>,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const maxDeletions = options.maxDeletions ?? 20;
  const result: ReconcileResult = { sessionRuleCount: 0, deletedRules: 0, deletedTargetGroups: 0 };

  if (!LISTENER_ARN) {
    return result;
  }

  const verdicts = new Map<string, boolean>();
  const orphan = async (sessionId: string): Promise<boolean> => {
    if (!verdicts.has(sessionId)) {
      verdicts.set(sessionId, await isOrphan(sessionId));
    }
    return verdicts.get(sessionId)!;
  };
  const budgetLeft = () => result.deletedRules + result.deletedTargetGroups < maxDeletions;

  try {
    const sessionRules = (await listAllRules())
      .map((rule) => ({ rule, sessionId: sessionOfRule(rule) }))
      .filter((entry): entry is { rule: Rule; sessionId: string } => entry.sessionId !== null);

    result.sessionRuleCount = sessionRules.length;

    for (const { rule, sessionId } of sessionRules) {
      if (!budgetLeft()) {
        break;
      }

      try {
        if (rule.RuleArn && (await orphan(sessionId))) {
          await client.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }));
          result.deletedRules++;
          console.log(`[alb-routing] Reconciled orphan rule for session ${sessionId}`);
        }
      } catch (err) {
        console.warn(`[alb-routing] Could not reconcile rule for session ${sessionId}:`, err);
      }
    }

    if (!budgetLeft()) {
      return result;
    }

    const groups = (await listSessionTargetGroups()).filter(
      (g) => g.TargetGroupArn && (g.LoadBalancerArns ?? []).length === 0,
    );

    for (let i = 0; i < groups.length && budgetLeft(); i += 20) {
      const batch = groups.slice(i, i + 20);
      const tags = await client.send(
        new DescribeTagsCommand({ ResourceArns: batch.map((g) => g.TargetGroupArn!) }),
      );

      for (const description of tags.TagDescriptions ?? []) {
        if (!budgetLeft()) {
          break;
        }

        const tagValue = (key: string) => description.Tags?.find((t) => t.Key === key)?.Value;
        const sessionId = tagValue('SessionId');

        if (!description.ResourceArn || tagValue('ManagedBy') !== managedByTag() || !sessionId) {
          continue;
        }

        try {
          if (await orphan(sessionId)) {
            await client.send(new DeleteTargetGroupCommand({ TargetGroupArn: description.ResourceArn }));
            result.deletedTargetGroups++;
            console.log(`[alb-routing] Reconciled orphan target group for session ${sessionId}`);
          }
        } catch (err) {
          console.warn(`[alb-routing] Could not reconcile target group for session ${sessionId}:`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[alb-routing] Routing reconciliation failed:', err);
  }

  return result;
}
