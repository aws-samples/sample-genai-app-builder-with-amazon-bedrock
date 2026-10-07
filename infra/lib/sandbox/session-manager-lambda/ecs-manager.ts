import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  StopTaskCommand,
  TagResourceCommand,
} from '@aws-sdk/client-ecs';

const client = new ECSClient({});
const CLUSTER_ARN = process.env.ECS_CLUSTER_ARN!;
const SERVICE_NAME = process.env.ECS_SERVICE_NAME!;

/**
 * Task tag naming the one session a task serves. Written at claim time, before
 * the session's URL is signed, and never removed: the sidecar reads it to decide
 * which session to accept, and its presence marks the task as used for good.
 */
export const SESSION_TAG_KEY = 'SandboxSession';

/** DescribeTasks accepts at most 100 tasks per call. */
const DESCRIBE_BATCH = 100;

export interface TaskInfo {
  taskArn: string;
  privateIp: string;
}

/**
 * Find a warm pool task that has never served a session.
 *
 * A task is single-use: once tagged with a session it is never offered again,
 * even after that session ends and its DynamoDB claim lock is gone, so one
 * tenant's container can never be handed to the next. Tasks named in
 * `claimedTaskArns` (live claims) or `exclude` (already tried by this caller)
 * are skipped too.
 */
export async function claimWarmTask(
  sessionId: string,
  claimedTaskArns?: Set<string>,
  exclude?: Set<string>,
): Promise<TaskInfo> {
  const listResult = await client.send(
    new ListTasksCommand({
      cluster: CLUSTER_ARN,
      serviceName: SERVICE_NAME,
      desiredStatus: 'RUNNING',
    }),
  );

  const taskArns = listResult.taskArns ?? [];

  if (taskArns.length === 0) {
    throw new Error('No warm pool tasks available');
  }

  for (let i = 0; i < taskArns.length; i += DESCRIBE_BATCH) {
    const describeResult = await client.send(
      new DescribeTasksCommand({
        cluster: CLUSTER_ARN,
        tasks: taskArns.slice(i, i + DESCRIBE_BATCH),
        include: ['TAGS'],
      }),
    );

    for (const task of describeResult.tasks ?? []) {
      const container = task.containers?.[0];

      if (!container || !task.taskArn) {
        continue;
      }

      if (claimedTaskArns?.has(task.taskArn) || exclude?.has(task.taskArn)) {
        continue;
      }

      // Ever claimed: never again.
      if (task.tags?.some((tag) => tag.key === SESSION_TAG_KEY)) {
        continue;
      }

      // Belt-and-suspenders: skip tasks started with a session override.
      const sessionEnv = task.overrides?.containerOverrides?.[0]?.environment?.find(
        (e) => e.name === 'SESSION_ID',
      );

      if (sessionEnv && sessionEnv.value && sessionEnv.value !== '') {
        continue;
      }

      // Get the private IP from the network attachment
      const attachment = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
      const eniDetail = attachment?.details?.find((d) => d.name === 'privateIPv4Address');
      const privateIp = eniDetail?.value || container.networkInterfaces?.[0]?.privateIpv4Address || '';

      if (!privateIp) {
        continue; // No IP yet, task may still be starting
      }

      return { taskArn: task.taskArn, privateIp };
    }
  }

  throw new Error('No unclaimed warm pool tasks available');
}

/**
 * Assign a task to a session by tagging it.
 *
 * Must succeed before the session's WebSocket URL is signed: the sidecar only
 * accepts the session named by this tag, so an untagged task refuses everyone.
 */
export async function tagTaskForSession(taskArn: string, sessionId: string): Promise<void> {
  await client.send(
    new TagResourceCommand({
      resourceArn: taskArn,
      tags: [{ key: SESSION_TAG_KEY, value: sessionId }],
    }),
  );
}

/** A running pool task and the session its tag assigns it to. */
export interface AssignedTask {
  taskArn: string;
  sessionId: string;
}

/**
 * Running pool tasks that carry a session tag. Used by the cleanup cron to find
 * tasks whose session ended without stopping them (they would otherwise hold
 * pool capacity forever, since a tagged task is never claimed again).
 */
export async function listAssignedTasks(): Promise<AssignedTask[]> {
  const listResult = await client.send(
    new ListTasksCommand({ cluster: CLUSTER_ARN, serviceName: SERVICE_NAME, desiredStatus: 'RUNNING' }),
  );
  const taskArns = listResult.taskArns ?? [];
  const assigned: AssignedTask[] = [];

  for (let i = 0; i < taskArns.length; i += DESCRIBE_BATCH) {
    const describeResult = await client.send(
      new DescribeTasksCommand({
        cluster: CLUSTER_ARN,
        tasks: taskArns.slice(i, i + DESCRIBE_BATCH),
        include: ['TAGS'],
      }),
    );

    for (const task of describeResult.tasks ?? []) {
      const sessionId = task.tags?.find((tag) => tag.key === SESSION_TAG_KEY)?.value;
      if (task.taskArn && sessionId) {
        assigned.push({ taskArn: task.taskArn, sessionId });
      }
    }
  }

  return assigned;
}

/**
 * Stop a specific ECS task.
 */
export async function stopTask(taskArn: string, reason: string): Promise<void> {
  await client.send(
    new StopTaskCommand({
      cluster: CLUSTER_ARN,
      task: taskArn,
      reason,
    }),
  );
}
