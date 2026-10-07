import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { SandboxVpc } from './sandbox-vpc';
import { SandboxSecurity } from './sandbox-security';
import { SandboxCluster } from './sandbox-cluster';
import { SandboxAlb } from './sandbox-alb';
import { SandboxSessions } from './sandbox-sessions';
import { SandboxEcrRebuild } from './sandbox-ecr-rebuild';

export interface SandboxInfrastructureProps {
  stackPrefix: string;
  kmsKey?: kms.IKey;
  logsBucket?: s3.IBucket;
  warmPoolSize?: number;
  maxCapacity?: number;
  /** Optional container image override for testing (avoids Docker build) */
  image?: import('aws-cdk-lib/aws-ecs').ContainerImage;
  /** Email(s) notified when the weekly container patch build fails. */
  alarmEmail?: string | string[];
  /** Value of the `X-Origin-Verify` header CloudFront sends to the sandbox ALB. */
  originVerifyHeaderValue: string;
  /**
   * Hosted zone and domain we own. When given, the ALB gets a certificate for
   * `sandbox-origin.<domainName>` (plus a DNS alias) so CloudFront can reach it
   * over TLS. Without it there is no hostname to certify and the hop is HTTP.
   */
  originTls?: { hostedZone: route53.IHostedZone; domainName: string };
}

/** Label under the custom domain that CloudFront uses to reach the sandbox ALB. */
export const SANDBOX_ORIGIN_LABEL = 'sandbox-origin';

export class SandboxInfrastructure extends Construct {
  public readonly vpc: SandboxVpc;
  public readonly security: SandboxSecurity;
  public readonly cluster: SandboxCluster;
  public readonly alb: SandboxAlb;
  public readonly sessions: SandboxSessions;
  public readonly ecrRebuild: SandboxEcrRebuild;
  /** Hostname CloudFront origins must use to reach the ALB. */
  public readonly originDomainName: string;
  /** True when the ALB terminates TLS for originDomainName (use HTTPS_ONLY origins). */
  public readonly originUsesTls: boolean;

  constructor(scope: Construct, id: string, props: SandboxInfrastructureProps) {
    super(scope, id);

    const { stackPrefix, kmsKey, logsBucket, warmPoolSize = 5, maxCapacity = 50, alarmEmail } = props;

    // VPC
    this.vpc = new SandboxVpc(this, 'Vpc', { stackPrefix });

    // Security Groups and NACLs
    this.security = new SandboxSecurity(this, 'Security', {
      stackPrefix,
      vpc: this.vpc.vpc,
    });

    // ECS Cluster + Service
    this.cluster = new SandboxCluster(this, 'Cluster', {
      stackPrefix,
      vpc: this.vpc.vpc,
      containerDir: path.join(__dirname, '..', 'sandbox-container'),
      image: props.image,
      containerSg: this.security.containerSg,
      warmPoolSize,
      maxCapacity,
    });

    // Certificate for the origin hostname. CloudFront validates the origin's
    // certificate against the origin domain, and the ALB's own *.elb.amazonaws.com
    // name can't be certified, so the ALB is given a name under our domain.
    // Regional (stack region), not us-east-1: it is used by the ALB.
    const originHost = props.originTls
      ? `${SANDBOX_ORIGIN_LABEL}.${props.originTls.domainName}`
      : undefined;
    const originCertificate = props.originTls
      ? new acm.Certificate(this, 'AlbOriginCertificate', {
          domainName: originHost!,
          validation: acm.CertificateValidation.fromDns(props.originTls.hostedZone),
        })
      : undefined;

    // Application Load Balancer
    this.alb = new SandboxAlb(this, 'Alb', {
      stackPrefix,
      vpc: this.vpc.vpc,
      albSg: this.security.albSg,
      logsBucket,
      originVerifyHeaderValue: props.originVerifyHeaderValue,
      certificate: originCertificate,
    });

    if (props.originTls) {
      new route53.ARecord(this, 'AlbOriginRecord', {
        zone: props.originTls.hostedZone,
        recordName: originHost,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb.alb)),
      });
    }
    this.originDomainName = originHost ?? this.alb.alb.loadBalancerDnsName;
    this.originUsesTls = originCertificate !== undefined;

    // Register the ECS service with the sidecar target group (port 8080). It
    // serves health checks only: no static rule forwards session traffic to the
    // pool any more (see sandbox-alb.ts).
    //
    // A claimed session gets its own target group and listener rule, created by
    // the session manager Lambda (see alb-routing.ts), so all of its
    // collaborators reach the single container serving it. A session without
    // one gets a 503.
    this.alb.sidecarTargetGroup.addTarget(
      this.cluster.service.loadBalancerTarget({
        containerName: `${stackPrefix}-sandbox-container`,
        containerPort: 8080,
      }),
    );

    // DynamoDB Sessions Table
    this.sessions = new SandboxSessions(this, 'Sessions', {
      stackPrefix,
      kmsKey,
    });

    // Scheduled container rebuild (weekly) to pick up OS security patches.
    // Pushes to a dedicated mutable ECR repo, registers a new task def
    // revision pointing to the patched image, then forces a new ECS deployment.
    this.ecrRebuild = new SandboxEcrRebuild(this, 'EcrRebuild', {
      stackPrefix,
      cluster: this.cluster.cluster,
      service: this.cluster.service,
      taskDefinition: this.cluster.taskDefinition,
      alarmEmail,
    });

    // Grant the ECS execution role permission to pull from the patch repo.
    // We use an explicit policy statement instead of grantPull() to avoid
    // CDK merging it with the fromAsset() grant and corrupting the ARN.
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    this.cluster.taskDefinition.executionRole!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
        ],
        resources: [
          this.ecrRebuild.repository.repositoryArn,
          `arn:aws:ecr:${region}:${account}:repository/cdk-hnb659fds-container-assets-${account}-${region}`,
        ],
      }),
    );

    // CloudFormation Outputs
    new cdk.CfnOutput(scope, 'SandboxAlbDnsName', {
      value: this.alb.alb.loadBalancerDnsName,
      description: 'Sandbox ALB DNS name',
    });

    new cdk.CfnOutput(scope, 'SandboxClusterArn', {
      value: this.cluster.cluster.clusterArn,
      description: 'Sandbox ECS cluster ARN',
    });

    new cdk.CfnOutput(scope, 'SandboxSessionsTableName', {
      value: this.sessions.table.tableName,
      description: 'Sandbox DynamoDB sessions table name',
    });
  }
}
