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
      originVerifyHeaderValue: 'test-origin-secret',
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

  /**
   * The WebSocket path rule must sit at a HIGH priority number. ALB evaluates
   * rules in ascending priority and stops at the first match, and the session
   * manager adds a per-session rule (from priority 100) for each claimed sandbox
   * so all of a session's collaborators reach one container. A low number here
   * would shadow those rules and send collaborators back to the shared pool.
   */
  test('creates the WebSocket fallback rule above the per-session band', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 900,
      Conditions: [
        {
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/ws/*'] },
        },
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: ['test-origin-secret'] },
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
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: ['test-origin-secret'] },
        },
      ],
    });
  });

  test('forwards nothing that lacks the CloudFront origin-verify header', () => {
    // Every forwarding rule must require it: a rule without it would let a
    // caller reach the containers without passing CloudFront's signed-URL check.
    const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');

    for (const rule of Object.values(rules)) {
      expect((rule as any).Properties.Conditions).toContainEqual({
        Field: 'http-header',
        HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: ['test-origin-secret'] },
      });
    }
  });

  test('creates exactly 2 listener rules (WS + preview)', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
  });
});
