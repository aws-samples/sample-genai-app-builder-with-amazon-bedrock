import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface SharedSitesBucketProps {
  stackPrefix: string;
  kmsKey?: kms.IKey;
}

export class SharedSitesBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SharedSitesBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${props.stackPrefix}-shared-sites-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: props.kmsKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: props.kmsKey,
      // Publishing a project uploads its built files straight from the browser
      // to presigned PUT URLs. Without a CORS rule the browser blocks that
      // cross-origin PUT at preflight, so Share silently failed. CORS governs
      // browser fetch/PUT only — it does not make the bucket public, which stays
      // locked by blockPublicAccess above. AllowedOrigins is '*' because the
      // CloudFront domain is not known at synth time and a presigned URL is
      // already the access control; only the upload verbs are allowed.
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3000,
      }],
      lifecycleRules: [{
        id: 'expire-shared-sites',
        prefix: 'shared/',
        expiration: cdk.Duration.days(30),
        enabled: true,
      }],
    });
  }
}
