import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SharedSitesBucket } from '../../lib/shared-sites/shared-sites-bucket';
import { SharedSitesTable } from '../../lib/shared-sites/shared-sites-table';

describe('SharedSitesBucket', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SharedSitesBucket(stack, 'SharedSites', { stackPrefix: 'test' });
    template = Template.fromStack(stack);
  });

  test('creates S3 bucket with public access blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('S3 bucket has 30-day lifecycle rule for shared/ prefix', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 30,
            Prefix: 'shared/',
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });
});

describe('SharedSitesTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SharedSitesTable(stack, 'SharesTable', { stackPrefix: 'test' });
    template = Template.fromStack(stack);
  });

  test('creates DynamoDB table with shareId partition key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'shareId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('has TTL on expiresAt attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  test('has GSI on userId for listing shares', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'byUserId',
          KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        }),
      ]),
    });
  });
});
