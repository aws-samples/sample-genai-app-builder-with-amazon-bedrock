import { env } from 'node:process';

/**
 * Resolve the AWS region from environment variables.
 *
 * Runs inside the Remix server which is hosted on AWS Lambda. The AWS SDK's
 * default provider chain (SSO, env vars, instance profile, etc.) handles
 * credentials; this helper only needs to pick the region.
 */
export function getAWSRegion(): string {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;

  if (!region) {
    throw new Error('AWS_REGION environment variable is not set.');
  }

  return region;
}
