import { ECSClient, ListTagsForResourceCommand } from '@aws-sdk/client-ecs';

/**
 * ECS task tag the session manager writes when it claims this task for a
 * session, before it signs that session's WebSocket URL. It is the only
 * authority on which session this container serves.
 */
export const SESSION_TAG_KEY = 'SandboxSession';

/** Resolves the session this task was assigned, or null if it has none yet. */
export type AssignedSessionResolver = () => Promise<string | null>;

export interface EcsTagSessionResolverOptions {
  /** Defaults to `ECS_CONTAINER_METADATA_URI_V4`, which ECS injects into every Fargate container. */
  metadataUri?: string;
  /** Tag lookup for a task ARN. Defaults to `ecs:ListTagsForResource` with the task role. */
  listTags?: (taskArn: string) => Promise<Array<{ key?: string; value?: string }>>;
  /** Per-call timeout for the metadata request. */
  timeoutMs?: number;
}

/**
 * Read this task's session assignment from its ECS tags.
 *
 * The task ARN comes from the task metadata endpoint, which is link-local to the
 * task, so the container learns its own identity rather than trusting anything a
 * client sends. The tags are then read through the ECS API (the Fargate v4
 * metadata endpoint does not document a `/taskWithTags` path, so the tags are
 * not taken from metadata).
 *
 * Every failure throws. The caller treats a throw exactly like "not assigned",
 * so an unreadable assignment fails closed.
 */
export function createEcsTagSessionResolver(
  options: EcsTagSessionResolverOptions = {},
): AssignedSessionResolver {
  const metadataUri = options.metadataUri ?? process.env.ECS_CONTAINER_METADATA_URI_V4 ?? '';
  const timeoutMs = options.timeoutMs ?? 3000;

  let ecs: ECSClient | null = null;
  const listTags =
    options.listTags ??
    (async (taskArn: string) => {
      ecs ??= new ECSClient({});
      const result = await ecs.send(new ListTagsForResourceCommand({ resourceArn: taskArn }));
      return result.tags ?? [];
    });

  let cachedTaskArn: string | null = null;

  return async () => {
    if (!metadataUri) {
      throw new Error('ECS task metadata endpoint is not configured');
    }

    if (!cachedTaskArn) {
      const res = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(timeoutMs) });

      if (!res.ok) {
        throw new Error(`Task metadata request failed with status ${res.status}`);
      }

      const body = (await res.json()) as { TaskARN?: string };

      if (!body.TaskARN) {
        throw new Error('Task metadata has no TaskARN');
      }

      cachedTaskArn = body.TaskARN;
    }

    const tags = await listTags(cachedTaskArn);
    const value = tags.find((tag) => tag.key === SESSION_TAG_KEY)?.value;

    return value ? value : null;
  };
}
