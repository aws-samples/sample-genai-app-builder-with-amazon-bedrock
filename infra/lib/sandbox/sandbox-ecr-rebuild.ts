import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface SandboxEcrRebuildProps {
  stackPrefix: string;
  cluster: ecs.ICluster;
  service: ecs.FargateService;
  /**
   * The sandbox task definition. Its task and execution roles are the only
   * roles the build may pass when it registers the patched revision.
   */
  taskDefinition: ecs.TaskDefinition;
  /**
   * Email address(es) notified when the weekly patch build fails. Without this
   * the build can fail silently and containers drift out of SLA (the exact
   * failure mode this construct exists to prevent). Accepts a single address or
   * a list. Optional so ephemeral/test stacks can skip it, but production stacks
   * SHOULD set it.
   */
  alarmEmail?: string | string[];
}

/**
 * Weekly scheduled CodeBuild that rebuilds the sandbox container with
 * --no-cache to pick up OS security patches, pushes to a dedicated
 * mutable ECR repo, registers a new task definition revision, then
 * updates the ECS service to use it.
 */
export class SandboxEcrRebuild extends Construct {
  public readonly buildProject: codebuild.Project;
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: SandboxEcrRebuildProps) {
    super(scope, id);

    const { stackPrefix, cluster, service, taskDefinition, alarmEmail } = props;
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Dedicated mutable ECR repo for patched images
    this.repository = new ecr.Repository(this, 'PatchRepo', {
      repositoryName: `${stackPrefix}-sandbox-patched`,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ description: 'Keep last 5 images', maxImageCount: 5 }],
    });

    // Upload the sandbox-container directory as an S3 asset for CodeBuild.
    // Exclude node_modules/dist (CodeBuild runs npm ci + npm run build).
    const sourceAsset = new s3_assets.Asset(this, 'SourceAsset', {
      path: path.join(__dirname, '..', 'sandbox-container'),
      exclude: ['**/node_modules', '**/dist', '**/*.d.ts'],
    });

    this.buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: `${stackPrefix}-sandbox-patch-build`,
      description: 'Weekly rebuild of sandbox container with latest OS security patches',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
      },
      environmentVariables: {
        CLUSTER_NAME: { value: cluster.clusterName },
        SERVICE_NAME: { value: service.serviceName },
        AWS_ACCOUNT_ID: { value: account },
        AWS_REGION_NAME: { value: region },
        PATCH_REPO: { value: this.repository.repositoryUri },
      },
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "=== Logging in to private ECR ==="',
              'aws ecr get-login-password --region $AWS_REGION_NAME | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION_NAME.amazonaws.com',
              'echo "=== Logging in to public ECR (for base images) ==="',
              'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws || true',
              'export IMAGE_TAG=patch-$(date +%Y%m%d-%H%M)',
            ],
          },
          build: {
            commands: [
              'echo "=== Building sandbox container (no-cache for fresh OS packages) ==="',
              'docker build --no-cache --platform linux/amd64 --build-arg CACHE_BUST=$(date +%s) -t $PATCH_REPO:$IMAGE_TAG -t $PATCH_REPO:latest .',
            ],
          },
          post_build: {
            commands: [
              'echo "=== Pushing to $PATCH_REPO ==="',
              'docker push $PATCH_REPO:$IMAGE_TAG',
              'docker push $PATCH_REPO:latest',
              'echo "=== Updating ECS task definition and service ==="',
              // Get the current task definition, swap the image, register new revision
              'TASK_DEF=$(aws ecs describe-services --cluster $CLUSTER_NAME --service $SERVICE_NAME --region $AWS_REGION_NAME --query "services[0].taskDefinition" --output text)',
              'aws ecs describe-task-definition --task-definition $TASK_DEF --region $AWS_REGION_NAME --query "taskDefinition" > /tmp/taskdef.json',
              // Replace the image in the container definition
              'cat /tmp/taskdef.json | python3 -c "import sys,json;td=json.load(sys.stdin);td[\'containerDefinitions\'][0][\'image\']=\'\'\'$PATCH_REPO:$IMAGE_TAG\'\'\';print(json.dumps(td[\'containerDefinitions\']))" > /tmp/containers.json',
              // Register new task definition revision
              'FAMILY=$(cat /tmp/taskdef.json | python3 -c "import sys,json;print(json.load(sys.stdin)[\'family\'])")',
              'TASK_ROLE=$(cat /tmp/taskdef.json | python3 -c "import sys,json;print(json.load(sys.stdin)[\'taskRoleArn\'])")',
              'EXEC_ROLE=$(cat /tmp/taskdef.json | python3 -c "import sys,json;print(json.load(sys.stdin)[\'executionRoleArn\'])")',
              'CPU=$(cat /tmp/taskdef.json | python3 -c "import sys,json;print(json.load(sys.stdin)[\'cpu\'])")',
              'MEM=$(cat /tmp/taskdef.json | python3 -c "import sys,json;print(json.load(sys.stdin)[\'memory\'])")',
              'STORAGE=$(cat /tmp/taskdef.json | python3 -c "import sys,json;td=json.load(sys.stdin);print(td.get(\'ephemeralStorage\',{}).get(\'sizeInGiB\',21))")',
              'aws ecs register-task-definition --family $FAMILY --task-role-arn $TASK_ROLE --execution-role-arn $EXEC_ROLE --network-mode awsvpc --requires-compatibilities FARGATE --cpu $CPU --memory $MEM --ephemeral-storage "sizeInGiB=$STORAGE" --container-definitions "$(cat /tmp/containers.json)" --region $AWS_REGION_NAME > /tmp/new-taskdef.json',
              'NEW_ARN=$(python3 -c "import json;print(json.load(open(\'/tmp/new-taskdef.json\'))[\'taskDefinition\'][\'taskDefinitionArn\'])")',
              'echo "Registered new task definition: $NEW_ARN"',
              // Update service to use new task definition
              'aws ecs update-service --cluster $CLUSTER_NAME --service $SERVICE_NAME --task-definition $NEW_ARN --force-new-deployment --region $AWS_REGION_NAME > /dev/null',
              'echo "=== Done — ECS will roll to the freshly patched image ==="',
            ],
          },
        },
      }),
    });

    sourceAsset.grantRead(this.buildProject);
    this.repository.grantPullPush(this.buildProject);

    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken'],
      resources: ['*'],
    }));

    // Roll only the sandbox service.
    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [service.serviceArn],
    }));

    // DescribeTaskDefinition and RegisterTaskDefinition do not support
    // resource-level permissions, so they cannot be narrowed below '*'. What
    // the new revision can do is bounded by the PassRole grant below.
    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition'],
      resources: ['*'],
    }));

    // Registering the revision passes the task's own roles back to ECS. Only
    // those two may be passed, so the build cannot hand a more privileged role
    // to a task.
    this.buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskDefinition.taskRole.roleArn, taskDefinition.obtainExecutionRole().roleArn],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      },
    }));

    // Weekly rebuild: every Monday at 06:00 UTC
    new events.Rule(this, 'WeeklyRebuildRule', {
      ruleName: `${stackPrefix}-sandbox-weekly-rebuild`,
      description: 'Weekly rebuild of sandbox container to pick up OS security patches',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', weekDay: 'MON' }),
      targets: [new targets.CodeBuildProject(this.buildProject)],
    });

    // Alarm on a FAILED patch build. This is the safety net: the whole point of
    // this construct is to keep containers within CVE-remediation SLA, so a
    // build that silently fails week after week is the worst failure mode — it
    // looks patched but isn't. CodeBuild emits a `FailedBuilds` metric per
    // project; fire on the first failure so someone can react before the next
    // weekly window (and before the running image drifts out of SLA).
    const failedBuildsMetric = new cloudwatch.Metric({
      namespace: 'AWS/CodeBuild',
      metricName: 'FailedBuilds',
      dimensionsMap: { ProjectName: this.buildProject.projectName },
      statistic: cloudwatch.Stats.SUM,
      period: cdk.Duration.hours(1),
    });

    const buildFailureAlarm = new cloudwatch.Alarm(this, 'PatchBuildFailureAlarm', {
      alarmName: `${stackPrefix}-sandbox-patch-build-failed`,
      alarmDescription:
        'Weekly sandbox container patch build FAILED — containers may drift out of CVE-remediation SLA. ' +
        'Investigate the CodeBuild project logs and re-run the build.',
      metric: failedBuildsMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Route the alarm to email when configured. Left unconfigured, the alarm
    // still exists and shows red in the console — but wire an address in prod
    // so nobody has to be watching the dashboard to notice. Accepts one address
    // or several; de-duped so a repeated address doesn't create two subscriptions.
    const alarmEmails = [...new Set((Array.isArray(alarmEmail) ? alarmEmail : alarmEmail ? [alarmEmail] : [])
      .map((e) => e.trim())
      .filter((e) => e.length > 0))];
    if (alarmEmails.length > 0) {
      const alarmTopic = new sns.Topic(this, 'PatchBuildAlarmTopic', {
        topicName: `${stackPrefix}-sandbox-patch-build-alarms`,
        displayName: 'Sandbox container patch build failures',
      });
      for (const email of alarmEmails) {
        alarmTopic.addSubscription(new sns_subs.EmailSubscription(email));
      }
      buildFailureAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

      // A SUCCEEDED build can still ship known CVEs when the fix lives outside
      // the distro (e.g. the base image's Debian release has no patched
      // package). ECR scans every pushed image; surface CRITICAL/HIGH findings
      // so a "green but vulnerable" image is caught the day it's pushed, not
      // when a security review flags the running tasks weeks later.
      new events.Rule(this, 'ScanFindingsRule', {
        ruleName: `${stackPrefix}-sandbox-patch-scan-findings`,
        description: 'Notify when an ECR scan of the patched sandbox image finds CRITICAL/HIGH CVEs',
        eventPattern: {
          source: ['aws.ecr'],
          detailType: ['ECR Image Scan'],
          detail: {
            'repository-name': [this.repository.repositoryName],
            'scan-status': ['COMPLETE'],
            'finding-severity-counts': {
              $or: [
                { CRITICAL: [{ numeric: ['>', 0] }] },
                { HIGH: [{ numeric: ['>', 0] }] },
              ],
            },
          },
        },
        targets: [new targets.SnsTopic(alarmTopic)],
      });
    }
  }
}
