import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SandboxAlb } from '../../lib/sandbox/sandbox-alb';

describe('SandboxAlb', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });

    const vpc = new ec2.Vpc(stack, 'TestVpc', { maxAzs: 2 });
    const albSg = new ec2.SecurityGroup(stack, 'TestAlbSg', { vpc });

    new SandboxAlb(stack, 'TestAlb', {
      stackPrefix: 'test',
      vpc,
      albSg,
    });

    template = Template.fromStack(stack);
  });

  test('creates an internet-facing ALB', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Name: 'test-sandbox-alb',
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('creates sidecar target group on port 8080', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'test-sbx-sidecar',
      Port: 8080,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPort: '8080',
      TargetGroupAttributes: Match.arrayWith([
        { Key: 'deregistration_delay.timeout_seconds', Value: '30' },
      ]),
    });
  });

  test('creates 2 listeners (HTTP redirect and HTTPS)', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
  });

  test('HTTP listener redirects to HTTPS', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [
        {
          Type: 'redirect',
          RedirectConfig: {
            Protocol: 'HTTPS',
            Port: '443',
            StatusCode: 'HTTP_301',
          },
        },
      ],
    });
  });

  test('HTTPS listener returns 503 for unmatched preview requests', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      DefaultActions: [
        {
          Type: 'fixed-response',
          FixedResponseConfig: {
            StatusCode: '503',
            ContentType: 'text/plain',
            MessageBody: 'No active preview session',
          },
        },
      ],
    });
  });

  test('creates WebSocket listener rule at priority 10', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [
        {
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/ws', '/ws/*'] },
        },
      ],
    });
  });

  test('creates preview listener rule at priority 20', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 20,
      Conditions: [
        {
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/sandbox-preview', '/sandbox-preview/*'] },
        },
      ],
    });
  });

  test('creates exactly 2 listener rules (WS + preview)', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
  });
});
