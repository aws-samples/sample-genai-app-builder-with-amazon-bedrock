import * as cdk from 'aws-cdk-lib';
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
}

/** Header CloudFront adds to every request it forwards to the sandbox ALB. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

export class SandboxAlb extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly sidecarTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: SandboxAlbProps) {
    super(scope, id);

    const { stackPrefix, vpc, albSg, logsBucket, originVerifyHeaderValue } = props;

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
    this.httpsListener = this.alb.addListener('HttpsListenerV2', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTP, // Use HTTP for now; swap to HTTPS with cert
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'No active preview session',
      }),
    });

    // WebSocket fallback: /ws/* → sidecar TG (round-robin).
    //
    // Deliberately a high priority number. ALB evaluates rules in ascending
    // priority and stops at the first match, so this path rule would shadow
    // anything above it — and the session manager adds a per-session rule for
    // each claimed sandbox (see alb-routing.ts) that must be evaluated first to
    // land every collaborator on one container. This stays as the fallback for
    // sessions that have no rule of their own.
    new elbv2.ApplicationListenerRule(this, 'WsRoute', {
      listener: this.httpsListener,
      priority: 900,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ws/*']), fromOurCloudFront],
      action: elbv2.ListenerAction.forward([this.sidecarTargetGroup]),
    });

    // Preview route: /sandbox-preview/* → sidecar TG (round-robin + sticky sessions).
    // The sidecar proxies to the local Vite dev server on :5173 for matching sessions.
    // Sticky sessions ensure that after the first successful hit, subsequent requests
    // go to the same container.
    new elbv2.ApplicationListenerRule(this, 'PreviewRoute', {
      listener: this.httpsListener,
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/sandbox-preview', '/sandbox-preview/*']),
        fromOurCloudFront,
      ],
      action: elbv2.ListenerAction.forward([this.sidecarTargetGroup]),
    });
  }
}
