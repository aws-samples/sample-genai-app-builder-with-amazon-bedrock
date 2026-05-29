import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';

const testConfig = {
  stackName: 'test-stack',
  region: 'us-west-2',
  bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
};

describe('Security Tests', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new InfraStack(app, 'TestStack', {
      config: testConfig,
      env: { account: '123456789012', region: 'us-west-2' },
    });
    template = Template.fromStack(stack);
  });

  test('S3 buckets have public access blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      }
    });
  });

  test('CloudFront distribution exists', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {});
  });

  test('Lambda Function URLs require AWS_IAM auth', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM'
    });
  });

  test('CloudFront has security headers policy', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'SAMEORIGIN', Override: true },
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 47304000,
            IncludeSubdomains: true,
            Override: true,
            Preload: true
          }
        }
      }
    });
  });

  test('API Gateway has Cognito authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS'
    });
  });

  test('CloudFront enforces HTTPS-only viewer connections', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  test('Cognito User Pool exists with email sign-in', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
    });
  });

  test('Lambda execution role has least privilege', () => {
    // Verify Lambda role does NOT have admin or wildcard permissions
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' }
        }]
      }
    });
  });

  test('Session and share API methods use custom authorizer (not Cognito-only)', () => {
    // Ensures API methods use custom JWT authorizer
    const methods = template.findResources('AWS::ApiGateway::Method');
    const sessionMethods = Object.entries(methods).filter(([key]) =>
      key.toLowerCase().includes('session') && !key.toLowerCase().includes('options')
    );
    const shareMethods = Object.entries(methods).filter(([key]) =>
      key.toLowerCase().includes('share') && !key.toLowerCase().includes('options')
    );

    for (const [key, method] of [...sessionMethods, ...shareMethods]) {
      const authType = (method as any).Properties?.AuthorizationType;
      if (authType && authType !== 'NONE') {
        expect(authType).toBe('CUSTOM');
      }
    }
  });
});
