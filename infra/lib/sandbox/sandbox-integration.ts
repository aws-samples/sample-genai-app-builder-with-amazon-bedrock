import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
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

    const { stackPrefix, kmsKey, logsBucket, warmPoolSize = 5, maxCapacity = 50 } = props;

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
    });

    // Register the ECS service with the sidecar target group (port 8080).
    // Preview traffic (port 5173) is routed via per-session ALB target groups
    // created dynamically by the session manager Lambda — not via ECS service registration.
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

    // Scheduled container rebuild (weekly) to pick up OS security patches
    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'EcrRepo', `${stackPrefix}-sandbox`);
    this.ecrRebuild = new SandboxEcrRebuild(this, 'EcrRebuild', {
      stackPrefix,
      repository: ecrRepo,
      cluster: this.cluster.cluster,
      service: this.cluster.service,
      containerDir: path.join(__dirname, '..', 'sandbox-container'),
    });

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
