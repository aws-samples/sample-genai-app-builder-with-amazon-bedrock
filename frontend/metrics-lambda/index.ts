import { CloudWatchClient, ListMetricsCommand, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const NAMESPACE = 'BedrockVibe';

export const handler = async () => {
  const region = process.env.AWS_REGION || 'us-west-2';
  const stackPrefix = process.env.STACK_PREFIX || 'bedrock-vibe';
  const userPoolId = process.env.COGNITO_USER_POOL_ID || '';

  const cw = new CloudWatchClient({ region });
  const cognito = new CognitoIdentityProviderClient({ region });
  const ssm = new SSMClient({ region });

  const now = new Date();
  const startOfTime = new Date('2024-01-01T00:00:00Z');

  // 1. Get total websites created — metrics are stored WITH a Model dimension,
  // so we first list all Model dimension values, then sum across all of them
  const listResult = await cw.send(new ListMetricsCommand({
    Namespace: NAMESPACE,
    MetricName: 'WebsiteCreated',
  }));

  let websitesCreated = 0;

  for (const metric of listResult.Metrics || []) {
    const result = await cw.send(new GetMetricStatisticsCommand({
      Namespace: NAMESPACE,
      MetricName: 'WebsiteCreated',
      Dimensions: metric.Dimensions,
      StartTime: startOfTime,
      EndTime: now,
      Period: 2592000,
      Statistics: ['Sum'],
    }));

    websitesCreated += (result.Datapoints || [])
      .reduce((sum, dp) => sum + (dp.Sum || 0), 0);
  }

  // 2. Get total unique users from Cognito user pool
  let cognitoUsers = 0;

  if (userPoolId) {
    let paginationToken: string | undefined;

    do {
      const result = await cognito.send(new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: 60,
        PaginationToken: paginationToken,
      }));

      cognitoUsers += (result.Users || []).length;
      paginationToken = result.PaginationToken;
    } while (paginationToken);
  }

  const totalUsers = cognitoUsers;

  // 3. Write to SSM Parameter Store
  const params = [
    { name: `/${stackPrefix}/metrics/total-users`, value: String(totalUsers) },
    { name: `/${stackPrefix}/metrics/websites-created`, value: String(Math.round(websitesCreated)) },
    { name: `/${stackPrefix}/metrics/updated-at`, value: String(Date.now()) },
  ];

  for (const param of params) {
    await ssm.send(new PutParameterCommand({
      Name: param.name,
      Value: param.value,
      Type: 'String',
      Overwrite: true,
    }));
  }

  console.log(`Metrics cached: users=${totalUsers}, websites=${Math.round(websitesCreated)}`);

  return { statusCode: 200, body: JSON.stringify({ totalUsers, websitesCreated: Math.round(websitesCreated) }) };
};
