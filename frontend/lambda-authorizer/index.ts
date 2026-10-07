import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * API Gateway REQUEST authorizer for the Cognito user pool.
 *
 * Every token is verified with `aws-jwt-verify` — AWS's published JWT library —
 * against the user pool's JWKS: signature, issuer, app client, token use and
 * expiry. Nothing about the token is trusted until that succeeds.
 *
 * The user pool and app client come from the function's environment, which the
 * stack sets (see `infra/lib/infra-stack.ts`).
 */

type Verifier = { verify(token: string): Promise<Record<string, unknown>> };

let verifier: Verifier | null = null;

/**
 * Build the verifier from the function's environment.
 *
 * Created once per execution environment so the downloaded JWKS is cached across
 * invocations. Exported so tests can preload a JWKS on the same instance.
 */
export function getVerifier(): Verifier {
  if (verifier) {
    return verifier;
  }

  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? '';
  const clientId = process.env.COGNITO_CLIENT_ID ?? '';

  if (!userPoolId || !clientId) {
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set');
  }

  verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' }) as unknown as Verifier;

  return verifier;
}

/** Reset the cached verifier. Intended for tests. */
export function __resetVerifier(): void {
  verifier = null;
}

function bearerToken(event: APIGatewayRequestAuthorizerEvent): string | undefined {
  const header = event.headers?.Authorization ?? event.headers?.authorization;

  return header?.replace(/^Bearer\s+/i, '') || undefined;
}

export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  const token = bearerToken(event);

  if (!token) {
    return generatePolicy('anonymous', 'Deny', event.methodArn);
  }

  let payload: Record<string, unknown>;

  try {
    payload = await getVerifier().verify(token);
  } catch (error) {
    console.log('Denied: token failed verification:', (error as Error).name);
    return generatePolicy('anonymous', 'Deny', event.methodArn);
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';

  if (!sub) {
    return generatePolicy('anonymous', 'Deny', event.methodArn);
  }

  const email = typeof payload.email === 'string' ? payload.email : '';

  // Analytics: track unique user authentication
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'BedrockVibe',
        Dimensions: [['UserId']],
        Metrics: [{ Name: 'UserLogin', Unit: 'Count' }],
      }],
    },
    UserId: sub,
    UserLogin: 1,
  };
  console.log(JSON.stringify(emf));

  // Use wildcard resource so the cached policy applies to all API methods.
  // Without this, a cached Allow for POST/session would Deny POST/stream.
  const arnParts = event.methodArn.split(':');
  const apiGatewayPart = arnParts[5].split('/');
  const wildcardArn = arnParts.slice(0, 5).join(':') + ':' + apiGatewayPart[0] + '/' + apiGatewayPart[1] + '/*';

  return generatePolicy(sub, 'Allow', wildcardArn, { userId: sub, email });
};

function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      }],
    },
    context,
  };
}
