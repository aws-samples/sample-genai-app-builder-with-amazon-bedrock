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
      lifecycleRules: [{
        id: 'expire-shared-sites',
        prefix: 'shared/',
        expiration: cdk.Duration.days(30),
        enabled: true,
      }],
    });
  }
}
