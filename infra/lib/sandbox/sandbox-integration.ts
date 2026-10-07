import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
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
}

export class SandboxInfrastructure extends Construct {
  public readonly vpc: SandboxVpc;
  public readonly security: SandboxSecurity;
  public readonly cluster: SandboxCluster;
  public readonly alb: SandboxAlb;
  public readonly sessions: SandboxSessions;
  public readonly ecrRebuild: SandboxEcrRebuild;

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

    // Application Load Balancer
    this.alb = new SandboxAlb(this, 'Alb', {
      stackPrefix,
      vpc: this.vpc.vpc,
      albSg: this.security.albSg,
      logsBucket,
      originVerifyHeaderValue: props.originVerifyHeaderValue,
    });

    // Register the ECS service with the sidecar target group (port 8080). This
    // group backs the static /ws/* and /sandbox-preview/* rules, which balance
    // across the whole warm pool.
    //
    // A session that has been claimed also gets its own target group and listener
    // rule, created by the session manager Lambda (see alb-routing.ts), so all of
    // its collaborators reach the single container serving it. Those per-session
    // rules take precedence; the static rules remain the fallback.
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
