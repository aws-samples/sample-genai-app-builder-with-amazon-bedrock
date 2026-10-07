import { generateKeyPairSync } from 'node:crypto';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Custom resource that creates the CloudFront key pair for sandbox WebSocket URLs.
 *
 * CloudFront signed URLs need an RSA key pair: CloudFront holds the public half
 * (in a trusted key group) and the session manager signs with the private half.
 * Neither CloudFormation nor Secrets Manager can generate an RSA key, so this
 * generates one with Node's standard library, writes the private key straight
 * into its Secrets Manager secret and returns only the public key.
 *
 * A new pair is generated on create and whenever `KeyVersion` changes; CloudFront
 * then receives a new public key and the session manager a new key pair id in the
 * same deployment. Delete is a no-op — the secret is removed with its own resource.
 */

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: { SecretArn: string; KeyVersion?: string };
}

const client = new SecretsManagerClient({});

export async function handler(event: CustomResourceEvent) {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const { SecretArn, KeyVersion = '1' } = event.ResourceProperties;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  await client.send(new PutSecretValueCommand({ SecretId: SecretArn, SecretString: privateKey }));

  return {
    PhysicalResourceId: `ws-signing-key-${KeyVersion}`,
    Data: { PublicKey: publicKey },
  };
}
