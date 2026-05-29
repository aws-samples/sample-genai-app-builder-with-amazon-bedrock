import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';

const testConfig = {
  stackName: 'teststack',
  region: 'us-west-2',
  bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
};

describe('KMS Integration Tests', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new InfraStack(app, 'TestStack', {
      config: testConfig,
      env: { account: '123456789012', region: 'us-west-2' },
    });
    template = Template.fromStack(stack);
  });

  test('should create customer-managed KMS key', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      Description: 'Customer-managed KMS key for Bedrock Vibe encryption',
      EnableKeyRotation: true
    });
  });

  test('should create KMS key alias', () => {
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/teststack-encryption-key'
    });
  });

  test('should encrypt S3 buckets with KMS', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms'
          }
        }]
      }
    });
  });
});
