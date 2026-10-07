import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface SandboxAlbProps {
  stackPrefix: string;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  logsBucket?: s3.IBucket;
  /**
   * Value CloudFront sends in the `X-Origin-Verify` header. Every forwarding rule
   * requires it, so only this stack's distributions reach the containers.
   */
  originVerifyHeaderValue: string;
  /**
   * Certificate for the hostname CloudFront uses to reach this ALB. When set,
   * the 443 listener terminates TLS. Without it the listener stays plain HTTP
   * (no hostname we own can be put on a certificate), and a synth warning says so.
   */
  certificate?: acm.ICertificate;
}

/** Header CloudFront adds to every request it forwards to the sandbox ALB. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

export class SandboxAlb extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly sidecarTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: SandboxAlbProps) {
    super(scope, id);

    const { stackPrefix, vpc, albSg, logsBucket, originVerifyHeaderValue, certificate } = props;

    // Only requests carrying this stack's origin-verify header are forwarded;
    // anything else falls through to the default 503.
    const fromOurCloudFront = elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [
      originVerifyHeaderValue,
    ]);

    // Application Load Balancer (internet-facing for CloudFront)
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${stackPrefix}-sandbox-alb`,
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    // Access logging if bucket provided
    if (logsBucket) {
      this.alb.logAccessLogs(logsBucket, `${stackPrefix}-sandbox-alb-logs`);
    }

    // Target group for sidecar (port 8080)
    this.sidecarTargetGroup = new elbv2.ApplicationTargetGroup(this, 'SidecarTg', {
      targetGroupName: `${stackPrefix}-sbx-sidecar`,
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        port: '8080',
        path: '/',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
      stickinessCookieDuration: cdk.Duration.hours(1),
    });

    // HTTP listener (port 80): redirect to HTTPS
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      // Ingress is managed in sandbox-security.ts (CloudFront only); without this
      // CDK opens the listener port to 0.0.0.0/0.
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // HTTPS listener (port 443): default returns 503 for unmatched requests.
    // Static rules route /ws/* and /sandbox-preview/* to the sidecar TG.
    //
    // The construct id is unchanged from the plain-HTTP version, so switching
    // protocol is an in-place listener update: the ARN the session manager uses
    // (SANDBOX_ALB_LISTENER_ARN) and the per-session rules it created survive.
    if (!certificate) {
      cdk.Annotations.of(this).addWarning(
        'Sandbox ALB: no certificate (no customDomain configured), so CloudFront reaches the ALB over ' +
          'plain HTTP on port 443. Configure customDomain to encrypt this hop.',
      );
    }
    this.httpsListener = this.alb.addListener('HttpsListenerV2', {
      port: 443,
      ...(certificate
        ? {
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates: [certificate],
            sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          }
        : { protocol: elbv2.ApplicationProtocol.HTTP }),
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'No active preview session',
      }),
    });

    // Session traffic is forwarded ONLY by the per-session rules the session
    // manager creates for each claimed sandbox (priorities 100-800, see
    // alb-routing.ts), each pinned to that session's one container.
    //
    // These static rules used to round-robin /ws/* and /sandbox-preview/* across
    // the whole pool as a fallback, so a session with no rule of its own (for
    // example once the listener hit its rule quota) landed on an arbitrary,
    // possibly another tenant's, container (Sev2 SOC D550368291). They now fail
    // closed with a 503. They sit above the per-session band so they never
    // shadow it.
    const noSessionRoute = elbv2.ListenerAction.fixedResponse(503, {
      contentType: 'text/plain',
      messageBody: 'No active sandbox session',
    });

    new elbv2.ApplicationListenerRule(this, 'WsRoute', {
      listener: this.httpsListener,
      priority: 900,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ws/*']), fromOurCloudFront],
      action: noSessionRoute,
    });

    new elbv2.ApplicationListenerRule(this, 'PreviewRoute', {
      listener: this.httpsListener,
      priority: 910,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/sandbox-preview', '/sandbox-preview/*']),
        fromOurCloudFront,
      ],
      action: noSessionRoute,
    });

    // Keeps the pool target group attached to this load balancer, which ECS
    // requires of a service's target group. Forwards only the sidecar's health
    // path, which carries no session data.
    new elbv2.ApplicationListenerRule(this, 'PoolHealthRoute', {
      listener: this.httpsListener,
      priority: 950,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/health']), fromOurCloudFront],
      action: elbv2.ListenerAction.forward([this.sidecarTargetGroup]),
    });

    // Per-session rules count against the listener's rule quota (100 by
    // default). Prod exhausted it once; warn well before that happens again.
    // The session manager publishes the count on every cleanup run.
    new cloudwatch.Alarm(this, 'SessionRuleCountAlarm', {
      alarmName: `${stackPrefix}-sandbox-session-rule-count`,
      alarmDescription:
        'Per-session ALB listener rules are approaching the listener rule quota; new sandbox sessions will fail',
      metric: new cloudwatch.Metric({
        namespace: `${stackPrefix}/Sandbox`,
        metricName: 'SessionRuleCount',
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
