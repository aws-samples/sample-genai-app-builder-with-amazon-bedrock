import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Annotations, Template, Match } from 'aws-cdk-lib/assertions';
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

  const rules = () =>
    Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).map(
      (rule: any) => rule.Properties,
    );
  const pathsOf = (rule: any): string[] =>
    rule.Conditions.flatMap((c: any) => c.PathPatternConfig?.Values ?? []);

  /**
   * Sev2 SOC D550368291. Session traffic is only ever forwarded by the
   * per-session rules the session manager creates (priorities 100-800). A
   * session without one must get a 503, never a round-robin forward that can
   * land on another tenant's container.
   */
  test('a WebSocket request with no per-session rule gets a fixed 503, not another container', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 900,
      Conditions: Match.arrayWith([{ Field: 'path-pattern', PathPatternConfig: { Values: ['/ws/*'] } }]),
      Actions: [
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '503' }),
        }),
      ],
    });
  });

  test('a preview request with no per-session rule gets a fixed 503, evaluated after the per-session band', () => {
    const preview = rules().filter((rule) => pathsOf(rule).some((p) => p.startsWith('/sandbox-preview')));

    expect(preview.length).toBeGreaterThan(0);
    for (const rule of preview) {
      // Above the per-session band (100-800), so it never shadows those rules.
      expect(rule.Priority).toBeGreaterThan(800);
      expect(rule.Actions).toEqual([
        expect.objectContaining({ Type: 'fixed-response', FixedResponseConfig: expect.objectContaining({ StatusCode: '503' }) }),
      ]);
    }
  });

  test('no static rule forwards session traffic to the shared pool', () => {
    for (const rule of rules()) {
      const forwards = rule.Actions.some((a: any) => a.Type === 'forward');
      const sessionPaths = pathsOf(rule).some((p) => p.startsWith('/ws') || p.startsWith('/sandbox-preview'));

      expect(forwards && sessionPaths).toBe(false);
    }
  });

  test('keeps the pool target group attached to the listener through a health-only rule', () => {
    // ECS refuses a service whose target group has no load balancer, so one
    // rule must keep it attached — and it may forward nothing but /health.
    const forwarding = rules().filter((rule) => rule.Actions.some((a: any) => a.Type === 'forward'));

    expect(forwarding).toHaveLength(1);
    expect(pathsOf(forwarding[0])).toEqual(['/health']);
  });

  test('alarms before per-session rules exhaust the listener rule quota', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'test/Sandbox',
      MetricName: 'SessionRuleCount',
      Threshold: 80,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
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

  test('creates exactly 3 static listener rules (WS 503, preview 503, pool health)', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
  });
});

describe('SandboxAlb with a certificate', () => {
  const build = (withCert: boolean) => {
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
      certificate: withCert
        ? acm.Certificate.fromCertificateArn(stack, 'Cert', 'arn:aws:acm:us-west-2:123456789012:certificate/abc')
        : undefined,
    });
    return stack;
  };

  test('the 443 listener terminates TLS with the given certificate', () => {
    Template.fromStack(build(true)).hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: [{ CertificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/abc' }],
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });
  });

  test('the listener logical id does not depend on the protocol (in-place update)', () => {
    const ids = (stack: cdk.Stack) =>
      Object.keys(
        Template.fromStack(stack).findResources('AWS::ElasticLoadBalancingV2::Listener', {
          Properties: { Port: 443 },
        }),
      );
    expect(ids(build(true))).toEqual(ids(build(false)));
  });

  test('warns only when there is no certificate', () => {
    Annotations.fromStack(build(false)).hasWarning('*', Match.stringLikeRegexp('plain HTTP'));
    Annotations.fromStack(build(true)).hasNoWarning('*', Match.stringLikeRegexp('plain HTTP'));
  });
});
