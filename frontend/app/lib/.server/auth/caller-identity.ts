/**
 * Resolve the caller identity that AWS has already verified for this request.
 *
 * The Remix Lambda is reachable through several entry paths: the API Gateway
 * REST proxy (some methods behind the REQUEST authorizer, the SSR pages public),
 * and the AWS_IAM Lambda Function URLs. A route that invokes the model must not
 * rely on the gateway alone, so it calls this and refuses the request when it
 * returns null.
 *
 * Only `event.requestContext` is trusted. AWS writes it: API Gateway puts the
 * authorizer's context there after the authorizer allowed the call, and the
 * Function URL puts the SigV4-verified caller there. Request headers and the
 * JSON body are caller-controlled and are never read here.
 *
 * `loadContext` is what `server.ts` / `streaming.ts` hand Remix: `{ event, context }`.
 */

export type VerifiedCaller =
  | { userId: string; via: 'api-gateway-authorizer' }
  | { userId: string; via: 'function-url-iam' }
  | { userId: string; via: 'local-dev' };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getVerifiedCaller(loadContext: unknown): VerifiedCaller | null {
  const event = (loadContext as { event?: { requestContext?: { authorizer?: unknown } } } | undefined)?.event;
  const authorizer = event?.requestContext?.authorizer as Record<string, unknown> | null | undefined;

  if (authorizer && typeof authorizer === 'object') {
    // API Gateway REST API + REQUEST authorizer: the authorizer's `context`
    // map is flattened onto requestContext.authorizer. Ours sets `userId` to
    // the verified token `sub` only on the Allow path.
    if (nonEmptyString(authorizer.userId)) {
      return { userId: authorizer.userId, via: 'api-gateway-authorizer' };
    }

    // Lambda Function URL with AuthType AWS_IAM: Lambda verified the SigV4
    // signature before invoking us and records the caller here.
    const iam = authorizer.iam as
      | { userArn?: unknown; userId?: unknown; cognitoIdentity?: { identityId?: unknown } | null }
      | undefined;

    if (iam && typeof iam === 'object' && nonEmptyString(iam.userArn)) {
      const identityId = iam.cognitoIdentity?.identityId;
      const userId = nonEmptyString(identityId) ? identityId : nonEmptyString(iam.userId) ? iam.userId : iam.userArn;

      return { userId, via: 'function-url-iam' };
    }
  }

  // `remix vite:dev` has no gateway in front of it. The Lambdas always run
  // with NODE_ENV=production (set in the CDK stack), so this never applies there.
  if (process.env.NODE_ENV === 'development') {
    return { userId: 'local-dev', via: 'local-dev' };
  }

  return null;
}

/** The 401 a model-invoking route returns when there is no verified caller. */
export function unauthenticatedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
