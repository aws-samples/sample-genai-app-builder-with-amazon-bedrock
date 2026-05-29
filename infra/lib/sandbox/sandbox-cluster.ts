import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface SandboxClusterProps {
  stackPrefix: string;
  vpc: ec2.IVpc;
  containerDir: string;
  /** Optional image override for testing (avoids Docker build) */
  image?: ecs.ContainerImage;
  containerSg: ec2.ISecurityGroup;
  warmPoolSize?: number;
  maxCapacity?: number;
}

export class SandboxCluster extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: SandboxClusterProps) {
    super(scope, id);

    const { stackPrefix, vpc, containerDir, containerSg, warmPoolSize = 5, maxCapacity = 50 } = props;

    // ECS Cluster with Container Insights
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${stackPrefix}-sandbox-cluster`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Fargate Task Definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${stackPrefix}-sandbox-task`,
      cpu: 1024,        // 1 vCPU
      memoryLimitMiB: 3072, // 3 GB
      ephemeralStorageGiB: 30,
    });

    // Allow sandbox containers to invoke Bedrock models (foundation models + inference profiles)
    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    }));

    // CloudWatch log group for the container
    const logGroup = new logs.LogGroup(this, 'ContainerLogGroup', {
      logGroupName: `/ecs/${stackPrefix}-sandbox`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Container definition
    this.taskDefinition.addContainer('SandboxContainer', {
      containerName: `${stackPrefix}-sandbox-container`,
      image: props.image ?? (() => {
        const imageUri = process.env.SIDECAR_IMAGE_URI;
        if (imageUri) {
          const [repoWithHost, tag] = imageUri.split(':');
          const repoName = repoWithHost.split('/').slice(1).join('/');
          const repo = ecr.Repository.fromRepositoryName(this, 'SidecarRepo', repoName);
          return ecs.ContainerImage.fromEcrRepository(repo, tag || 'latest');
        }
        return ecs.ContainerImage.fromAsset(containerDir, {
          platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
        });
      })(),
      portMappings: [
        { containerPort: 8080, protocol: ecs.Protocol.TCP },
        { containerPort: 3000, protocol: ecs.Protocol.TCP },
        { containerPort: 5173, protocol: ecs.Protocol.TCP },
      ],
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'sandbox',
      }),
      environment: {
        SESSION_ID: '', // Set by session manager at runtime
        PREVIEW_DOMAIN: '',
      },
      essential: true,
    });

    // Fargate Service (warm pool)
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${stackPrefix}-sandbox-service`,
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: warmPoolSize,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [containerSg],
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(120),
    });

    // ── Auto-scaling based on available (unclaimed) tasks ─────────
    // The session Lambda publishes AvailableTaskCount after each
    // create/delete/cleanup. Scale out when running low on warm tasks,
    // scale in when too many are idle.
    if (maxCapacity > warmPoolSize) {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: warmPoolSize,
        maxCapacity,
      });

      const availableMetric = new cloudwatch.Metric({
        namespace: `${stackPrefix}/Sandbox`,
        metricName: 'AvailableTaskCount',
        statistic: 'Minimum',
        period: cdk.Duration.minutes(1),
      });

      // Scale out: add 5 tasks when fewer than 2 are available
      scaling.scaleOnMetric('ScaleOutOnLowAvailability', {
        metric: availableMetric,
        scalingSteps: [
          { upper: 1, change: +10 }, // 0-1 available: add 10 urgently
          { upper: 3, change: +5 },  // 2-3 available: add 5
        ],
        adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: cdk.Duration.minutes(2),
      });

      // Scale in: remove tasks when too many are idle
      scaling.scaleOnMetric('ScaleInOnHighAvailability', {
        metric: availableMetric,
        scalingSteps: [
          { lower: 15, change: -5 },  // 15+ available: remove 5
          { lower: 10, change: -2 },  // 10-14 available: remove 2
        ],
        adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: cdk.Duration.minutes(5),
      });
    }
  }
}
