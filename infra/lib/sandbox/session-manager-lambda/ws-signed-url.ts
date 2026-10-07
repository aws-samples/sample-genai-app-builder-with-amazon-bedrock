import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

/**
 * CloudFront signed URLs for the sandbox WebSocket upgrade.
 *
 * The session id is not a secret — it appears in preview URLs and load-balancer
 * logs — and the socket exposes a shell in the workspace, so knowing the id must
 * not be enough to connect. This Lambda is the component that knows ownership and
 * membership, so it makes that decision and expresses it as a CloudFront signed
 * URL scoped to one session's `/ws/` path. CloudFront verifies the signature
 * against the distribution's trusted key group and rejects anything else before
 * it reaches the load balancer; the container itself performs no authentication.
 *
 * Signing uses the AWS SDK's CloudFront signer, and the private key lives in
 * Secrets Manager. Nothing here is a bespoke token format.
 */

/** Short enough that a leaked URL expires before it is useful. */
export const SIGNED_URL_TTL_SECONDS = 120;

/**
 * The signing key, fetched from Secrets Manager and cached for the life of the
 * execution environment.
 *
 * Kept out of the Lambda's environment variables — and therefore out of the
 * CloudFormation template and the console — because a key that grants shell
 * access should not be readable by anyone who can describe the function.
 */
let cachedKey: string | null = null;

export async function getSigningKey(): Promise<string> {
  if (cachedKey) {
    return cachedKey;
  }

  const arn = process.env.WS_SIGNING_KEY_SECRET_ARN ?? '';

  if (!arn) {
    throw new Error('WS_SIGNING_KEY_SECRET_ARN is not configured — cannot sign WebSocket URLs');
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const key = result.SecretString ?? '';

  if (!key.includes('PRIVATE KEY')) {
    throw new Error('WebSocket signing key secret does not hold a PEM private key');
  }

  cachedKey = key;
  return key;
}

/**
 * A `wss://` URL for `sessionId` on `domain`, signed so CloudFront admits it.
 *
 * The custom policy covers this session's path only — a URL issued for one
 * session cannot open another, so an invited collaborator cannot reach any other
 * container — and expires after `SIGNED_URL_TTL_SECONDS`. It is checked once, on
 * the upgrade; an established socket is unaffected by expiry.
 *
 * Throws when no key pair is configured: handing out an unsigned URL would only
 * produce a connection CloudFront refuses.
 */
export function signWsUrl(
  domain: string,
  sessionId: string,
  privateKey: string,
  keyPairId: string = process.env.WS_SIGNING_KEY_PAIR_ID ?? '',
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  if (!keyPairId || !privateKey) {
    throw new Error('No CloudFront key pair — cannot sign a WebSocket URL');
  }

  // CloudFront evaluates the upgrade as an HTTPS request, so the policy and the
  // signature are over the https:// form; the browser dials the wss:// form.
  const url = `https://${domain}/ws/${encodeURIComponent(sessionId)}`;
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${url}*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': nowSeconds + SIGNED_URL_TTL_SECONDS } },
      },
    ],
  });

  return getSignedUrl({ url, keyPairId, privateKey, policy }).replace(/^https:/, 'wss:');
}
