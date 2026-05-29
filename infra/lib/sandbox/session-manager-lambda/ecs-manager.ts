import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';

const client = new ECSClient({});
const CLUSTER_ARN = process.env.ECS_CLUSTER_ARN!;
const SERVICE_NAME = process.env.ECS_SERVICE_NAME!;

interface TaskInfo {
  taskArn: string;
  privateIp: string;
}

/**
 * Find an available (unassigned) warm pool task and claim it for a session.
 * Skips tasks whose ARN is already claimed by another session in DynamoDB.
 */
export async function claimWarmTask(sessionId: string, claimedTaskArns?: Set<string>): Promise<TaskInfo> {
  const listResult = await client.send(
    new ListTasksCommand({
      cluster: CLUSTER_ARN,
      serviceName: SERVICE_NAME,
      desiredStatus: 'RUNNING',
    }),
  );

  if (!listResult.taskArns || listResult.taskArns.length === 0) {
    throw new Error('No warm pool tasks available');
  }

  const describeResult = await client.send(
    new DescribeTasksCommand({
      cluster: CLUSTER_ARN,
      tasks: listResult.taskArns,
    }),
  );

  if (!describeResult.tasks) {
    throw new Error('Failed to describe tasks');
  }

  // Find a task that doesn't have a session assigned
  for (const task of describeResult.tasks) {
    const container = task.containers?.[0];

    if (!container) {
      continue;
    }

    // Primary check: skip tasks already claimed in DynamoDB
    if (claimedTaskArns && task.taskArn && claimedTaskArns.has(task.taskArn)) {
      continue;
    }

    // Secondary check: skip tasks with ECS override (belt-and-suspenders)
    const sessionEnv = task.overrides?.containerOverrides?.[0]?.environment?.find(
      (e) => e.name === 'SESSION_ID',
    );

    if (sessionEnv && sessionEnv.value && sessionEnv.value !== '') {
      continue; // Already claimed
    }

    // Get the private IP from the network attachment
    const attachment = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
    const eniDetail = attachment?.details?.find((d) => d.name === 'privateIPv4Address');
    const privateIp = eniDetail?.value || container.networkInterfaces?.[0]?.privateIpv4Address || '';

    if (!privateIp) {
      continue; // No IP yet, task may still be starting
    }

    return {
      taskArn: task.taskArn!,
      privateIp,
    };
  }

  throw new Error('No unclaimed warm pool tasks available');
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

