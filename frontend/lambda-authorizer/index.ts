import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';

// JWT authorizer - validates token structure and expiry
// For production, add JWKS validation against your Cognito User Pool's JWKS endpoint

export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  console.log('🔐 Authorizer invoked');
  
  const token = event.headers?.Authorization?.replace('Bearer ', '') 
             || event.headers?.authorization?.replace('Bearer ', '');
  
  if (!token) {
    console.log('❌ No token provided');
    return generatePolicy('anonymous', 'Deny', event.methodArn);
  }

  try {
    // Decode JWT (without verification for now - add JWKS verification for production)
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    console.log('📋 Token payload:', { sub: payload.sub, exp: payload.exp, iss: payload.iss });

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.log('❌ Token expired');
      return generatePolicy('anonymous', 'Deny', event.methodArn);
    }

    // Check issuer: only accept Cognito tokens
    const iss = payload.iss || '';
    if (!iss.includes('cognito-idp')) {
      console.log('❌ Invalid issuer:', iss);
      return generatePolicy('anonymous', 'Deny', event.methodArn);
    }

    console.log('✅ Token valid for user:', payload.sub);

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
      UserId: payload.sub || 'unknown',
      UserLogin: 1,
    };
    console.log(JSON.stringify(emf));

    // Use wildcard resource so the cached policy applies to all API methods.
    // Without this, a cached Allow for POST/session would Deny POST/stream.
    const arnParts = event.methodArn.split(':');
    const apiGatewayPart = arnParts[5].split('/');
    const wildcardArn = arnParts.slice(0, 5).join(':') + ':' + apiGatewayPart[0] + '/' + apiGatewayPart[1] + '/*';

    console.log('📋 Method ARN:', event.methodArn);
    console.log('📋 Wildcard ARN:', wildcardArn);
    console.log('📋 Returning Allow policy with context:', { userId: payload.sub, email: payload.email });

    return generatePolicy(payload.sub || 'user', 'Allow', wildcardArn, {
      userId: payload.sub || '',
      email: payload.email || '',
    });
  } catch (error) {
    console.error('❌ Token validation failed:', error);
    return generatePolicy('anonymous', 'Deny', event.methodArn);
  }
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
