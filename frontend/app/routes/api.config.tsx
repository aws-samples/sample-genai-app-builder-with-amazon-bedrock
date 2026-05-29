import type { LoaderFunction } from '@remix-run/node';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BUILD_CONFIG } from '~/lib/build-config';

async function getSSMParameter(client: SSMClient, name: string): Promise<string | null> {
  try {
    const response = await client.send(new GetParameterCommand({ Name: name }));
    return response.Parameter?.Value || null;
  } catch {
    return null;
  }
}

export const loader: LoaderFunction = async () => {
  const region = BUILD_CONFIG.AWS_REGION;
  const prefix = BUILD_CONFIG.STACK_PREFIX.toLowerCase();

  // Server-side SSM client uses Lambda's IAM role
  const ssmClient = new SSMClient({ region });

  const [
    cognitoUserPoolId,
    cognitoUserPoolClientId,
    cognitoIdentityPoolId,
    remixFunctionUrl,
    streamingFunctionUrl,
    apiGatewayStreamUrl,
    apiGatewayRestUrl,
  ] = await Promise.all([
    getSSMParameter(ssmClient, `/${prefix}/cognito/user-pool-id`),
    getSSMParameter(ssmClient, `/${prefix}/cognito/user-pool-client-id`),
    getSSMParameter(ssmClient, `/${prefix}/cognito/identity-pool-id`),
    getSSMParameter(ssmClient, `/${prefix}/lambda/remix-function-url`),
    getSSMParameter(ssmClient, `/${prefix}/lambda/streaming-function-url`),
    getSSMParameter(ssmClient, `/${prefix}/api-gateway/stream-url`),
    getSSMParameter(ssmClient, `/${prefix}/api-gateway/rest-url`),
  ]);

  return Response.json({
    AWS_REGION: region,
    STACK_PREFIX: prefix,
    COGNITO_USER_POOL_ID: cognitoUserPoolId,
    COGNITO_USER_POOL_CLIENT_ID: cognitoUserPoolClientId,
    COGNITO_IDENTITY_POOL_ID: cognitoIdentityPoolId,
    REMIX_FUNCTION_URL: remixFunctionUrl,
    STREAMING_FUNCTION_URL: streamingFunctionUrl,
    API_GATEWAY_STREAM_URL: apiGatewayStreamUrl,
    API_GATEWAY_REST_URL: apiGatewayRestUrl,
  });
};
