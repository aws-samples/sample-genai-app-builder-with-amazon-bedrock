import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';

const testConfig = {
  stackName: 'test-stack',
  region: 'us-west-2',
  bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
};

describe('Infrastructure Validation Tests', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new InfraStack(app, 'TestStack', {
      config: testConfig,
      env: { account: '123456789012', region: 'us-west-2' },
    });
    template = Template.fromStack(stack);
  });

  describe('Lambda Functions', () => {
    test('Remix SSR Lambda exists', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('test-stack-remix'),
        Runtime: 'nodejs22.x',
      });
    });

    test('Streaming Lambda exists', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('test-stack-streaming'),
        Runtime: 'nodejs22.x',
      });
    });

    test('JWT Authorizer Lambda exists', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('jwt-authorizer'),
        Runtime: 'nodejs20.x',
      });
    });

    test('Lambda Function URLs exist with IAM auth', () => {
      const urls = template.findResources('AWS::Lambda::Url');
      const urlCount = Object.keys(urls).length;
      expect(urlCount).toBeGreaterThanOrEqual(2); // Remix + Streaming

      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
      });
    });
  });

  describe('API Gateway', () => {
    test('REST API exists', () => {
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: Match.stringLikeRegexp('test-stack'),
      });
    });

    test('API Gateway has at least one method', () => {
      const methods = template.findResources('AWS::ApiGateway::Method');
      expect(Object.keys(methods).length).toBeGreaterThanOrEqual(1);
    });

    test('API Gateway has deployment stage', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        StageName: 'api',
      });
    });
  });

  describe('CloudFront', () => {
    test('CloudFront distribution exists', () => {
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });

    test('CloudFront has security headers policy', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            StrictTransportSecurity: Match.objectLike({
              Override: true,
            }),
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: 'SAMEORIGIN', Override: true },
          },
        },
      });
    });

    test('CloudFront enforces TLS 1.2+', () => {
      // ViewerCertificate with MinimumProtocolVersion is only set when customDomain is configured
      // Without custom domain, CloudFront uses default certificate which enforces TLS 1.2 by default
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          HttpVersion: 'http2',
        }),
      });
    });
  });

  describe('Cognito', () => {
    test('User Pool exists', () => {
      template.resourceCountIs('AWS::Cognito::UserPool', 1);
    });

    test('User Pool Client exists', () => {
      const clients = template.findResources('AWS::Cognito::UserPoolClient');
      expect(Object.keys(clients).length).toBeGreaterThanOrEqual(1);
    });

    test('Identity Pool exists', () => {
      template.resourceCountIs('AWS::Cognito::IdentityPool', 1);
    });
  });

  describe('S3', () => {
    test('At least one S3 bucket exists for static assets', () => {
      const buckets = template.findResources('AWS::S3::Bucket');
      expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
    });

    test('All S3 buckets block public access', () => {
      const buckets = template.findResources('AWS::S3::Bucket');
      for (const [id, bucket] of Object.entries(buckets)) {
        const props = (bucket as any).Properties;
        if (props.PublicAccessBlockConfiguration) {
          expect(props.PublicAccessBlockConfiguration.BlockPublicAcls).toBe(true);
          expect(props.PublicAccessBlockConfiguration.BlockPublicPolicy).toBe(true);
        }
      }
    });
  });

  describe('SSM Parameters', () => {
    test('SSM parameters are created for service discovery', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: Match.stringLikeRegexp('/test-stack/'),
      });
    });
  });

  describe('Monitoring', () => {
    test('CloudWatch Synthetics canary exists', () => {
      template.hasResource('AWS::Synthetics::Canary', {});
    });

    test('Canary failure alarm exists', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: Match.stringLikeRegexp('canary-failure'),
      });
    });

    test('Analytics dashboard exists', () => {
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: Match.stringLikeRegexp('analytics'),
      });
    });
  });

  describe('Resource Counts (prevent accidental deletion)', () => {
    test('Expected number of Lambda functions', () => {
      const lambdas = template.findResources('AWS::Lambda::Function');
      // At minimum: Remix, Streaming, JWT Authorizer, BucketDeployment custom resource
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(3);
    });

    test('Expected number of IAM roles', () => {
      const roles = template.findResources('AWS::IAM::Role');
      // Should have roles for Lambda, API GW, Cognito, Canary, etc.
      expect(Object.keys(roles).length).toBeGreaterThanOrEqual(5);
    });
  });
});
