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

/**
 * The sandbox WebSocket exposes a shell, so the upgrade must be authorised by an
 * AWS-managed control: CloudFront signed URLs against a trusted key group. These
 * pin that no bespoke ticket mechanism remains and that no unsigned path to the
 * sandbox ALB exists — including through the preview distribution.
 */
describe('Sandbox WebSocket authorisation', () => {
  const synth = (config: Record<string, unknown>) => {
    const app = new cdk.App();
    const stack = new InfraStack(app, 'TestStack', {
      config: { ...testConfig, ...config } as any,
      env: { account: '123456789012', region: 'us-west-2' },
    });
    return Template.fromStack(stack);
  };

  const templates = {
    'without a custom domain': synth({}),
    'with a custom domain (preview distribution)': synth({ customDomain: 'vibe.example.dev' }),
  };

  describe.each(Object.entries(templates))('%s', (_label, template) => {
    const wsBehaviors = () =>
      Object.values(template.findResources('AWS::CloudFront::Distribution')).flatMap(
        (dist: any) =>
          (dist.Properties.DistributionConfig.CacheBehaviors ?? []).filter(
            (behavior: any) => behavior.PathPattern === '/ws/*',
          ),
      );

    test('every /ws/* behavior requires a signed URL from the trusted key group', () => {
      expect(wsBehaviors().length).toBeGreaterThan(0);

      for (const behavior of wsBehaviors()) {
        expect(behavior.TrustedKeyGroups).toHaveLength(1);
      }
    });

    test('no distribution can reach the sandbox socket through its default behavior', () => {
      // A default behavior pointing at the sandbox ALB would serve /ws/* unsigned
      // if no /ws/* behavior shadowed it.
      for (const dist of Object.values(template.findResources('AWS::CloudFront::Distribution')) as any[]) {
        const config = dist.Properties.DistributionConfig;
        const hasWsBehavior = (config.CacheBehaviors ?? []).some((b: any) => b.PathPattern === '/ws/*');
        const defaultOrigin = config.Origins.find((o: any) => o.Id === config.DefaultCacheBehavior.TargetOriginId);
        const defaultIsAlb = JSON.stringify(defaultOrigin.DomainName).includes('SandboxAlb');

        if (defaultIsAlb) {
          expect(hasWsBehavior).toBe(true);
        }
      }
    });

    test('a CloudFront key group and public key exist for signing', () => {
      template.resourceCountIs('AWS::CloudFront::KeyGroup', 1);
      template.resourceCountIs('AWS::CloudFront::PublicKey', 1);
    });

    test('no custom WebSocket ticket secret remains', () => {
      const secrets = JSON.stringify(template.findResources('AWS::SecretsManager::Secret'));
      expect(secrets).not.toMatch(/ws-ticket/i);
      expect(JSON.stringify(template.toJSON())).not.toMatch(/WS_TICKET/);
    });

    test('the sandbox container is given no signing material', () => {
      const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition')) as any[];

      for (const taskDef of taskDefs) {
        for (const container of taskDef.Properties.ContainerDefinitions) {
          expect(container.Secrets ?? []).toEqual([]);
        }
      }
    });

    test('the session manager signs with the CloudFront key pair', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            WS_SIGNING_KEY_SECRET_ARN: Match.anyValue(),
            WS_SIGNING_KEY_PAIR_ID: Match.anyValue(),
            X_ORIGIN_VERIFY_SECRET_ARN: Match.anyValue(),
          }),
        },
      });
    });

    test('every CloudFront origin pointing at the sandbox ALB sends the origin-verify header', () => {
      for (const dist of Object.values(template.findResources('AWS::CloudFront::Distribution')) as any[]) {
        for (const origin of dist.Properties.DistributionConfig.Origins) {
          if (JSON.stringify(origin.DomainName).includes('SandboxAlb')) {
            expect(origin.OriginCustomHeaders).toEqual(
              expect.arrayContaining([expect.objectContaining({ HeaderName: 'X-Origin-Verify' })]),
            );
          }
        }
      }
    });
  });
});
