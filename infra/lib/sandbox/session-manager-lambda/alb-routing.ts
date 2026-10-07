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
  RegisterTargetsCommand,
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
 * Per-session rules must be evaluated BEFORE the static `/ws/*` fallback.
 *
 * ALB walks rules in ascending priority and stops at the first match, so a lower
 * number wins. The `/ws/*` path rule matches every WebSocket request, so it sits
 * at priority 900 (see sandbox-alb.ts) and this band sits below it.
 */
const PRIORITY_BASE = 100;
/**
 * Bounded below the `/ws/*` fallback at 900, and well inside the default limit of
 * 100 rules per listener. Exhaustion is not fatal: a session with no rule of its
 * own falls through to the fallback and behaves exactly as it did before (solo
 * editing works, but a second browser may not reach the same container).
 */
const PRIORITY_LIMIT = 800;

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
  return `sbx-s-${digest}`;
}

/**
 * Derive a task's private IP from the hostname the sidecar reports as its
 * `containerId` (awsvpc tasks are named `ip-10-1-2-3.<region>.compute.internal`).
 *
 * The container is the authority on which box it is. Claiming a task only writes
 * a DynamoDB record — nothing tells that container it now owns a session — so a
 * claim can point at a different box than the one that actually answers. Reading
 * the identity back out of the connection avoids trusting the claim.
 *
 * Returns null for any hostname that is not in that form, so a caller falls back
 * to the claimed address rather than pinning a guess.
 */
export function taskIpFromContainerId(containerId: string | undefined): string | null {
  const match = /^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\./.exec(containerId ?? '');

  if (!match) {
    return null;
  }

  const octets = match.slice(1, 5).map(Number);

  if (octets.some((octet) => octet > 255)) {
    return null;
  }

  return octets.join('.');
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
 * non-fatal: the static catch-all rule still serves the session.
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

  try {
    const targetGroupArn = await ensureTargetGroup(sessionId);

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
      return null;
    }

    console.log(`[alb-routing] Pinned session ${sessionId} to ${privateIp}`);

    return { targetGroupArn, ruleArn };
  } catch (err) {
    console.error(`[alb-routing] Failed to provision routing for ${sessionId}:`, err);
    return null;
  }
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
        { Key: 'ManagedBy', Value: `${STACK_PREFIX}-session-manager` },
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
      console.warn(
        `[alb-routing] No free rule priority for ${sessionId} — falling back to shared routing`,
      );
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
                HttpHeaderName: 'x-sandbox-session',
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
    const rules = await client.send(new DescribeRulesCommand({ ListenerArn: LISTENER_ARN }));

    for (const rule of rules.Rules ?? []) {
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
