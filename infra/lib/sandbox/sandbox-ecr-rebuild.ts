import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface SandboxEcrRebuildProps {
  stackPrefix: string;
  repository: ecr.IRepository;
  cluster: ecs.ICluster;
  service: ecs.FargateService;
  containerDir: string;
}

export class SandboxEcrRebuild extends Construct {
  public readonly buildProject: codebuild.Project;

  constructor(scope: Construct, id: string, props: SandboxEcrRebuildProps) {
    super(scope, id);

    const { stackPrefix, repository, cluster, service, containerDir } = props;
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    this.buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: `${stackPrefix}-sandbox-build`,
      description: 'Rebuilds sandbox container image with latest OS patches and deploys to ECS',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
      },
      source: codebuild.Source.s3({
        bucket: cdk.aws_s3.Bucket.fromBucketName(this, 'AssetBucket', `cdk-hnb659fds-assets-${account}-${region}`),
        path: '', // Set dynamically by CDK asset
      }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "=== Logging in to private ECR ==="',
              `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${account}.dkr.ecr.${region}.amazonaws.com`,
              'echo "=== Logging in to public ECR (for base images) ==="',
              'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws || true',
            ],
          },
          build: {
            commands: [
              'echo "=== Building sandbox container (no-cache for fresh OS packages) ==="',
              `docker build --no-cache --platform linux/amd64 -t ${repository.repositoryUri}:latest .`,
            ],
          },
          post_build: {
            commands: [
              'echo "=== Pushing to ECR ==="',
              `docker push ${repository.repositoryUri}:latest`,
              'echo "=== Forcing ECS redeployment ==="',
              `aws ecs update-service --cluster ${cluster.clusterName} --service ${service.serviceName} --force-new-deployment --region ${region}`,
              'echo "=== Done ==="',
            ],
          },
        },
      }),
    });

    repository.grantPullPush(this.buildProject);

    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken'],
      resources: ['*'],
    }));

    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [service.serviceArn],
    }));

    // Weekly rebuild: every Monday at 06:00 UTC
    new events.Rule(this, 'WeeklyRebuildRule', {
      ruleName: `${stackPrefix}-sandbox-weekly-rebuild`,
      description: 'Weekly rebuild of sandbox container to pick up OS security patches',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', weekDay: 'MON' }),
      targets: [new targets.CodeBuildProject(this.buildProject)],
    });
  }
}
