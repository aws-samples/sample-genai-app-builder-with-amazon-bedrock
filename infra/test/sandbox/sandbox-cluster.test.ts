import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SandboxCluster } from '../../lib/sandbox/sandbox-cluster';

// SandboxCluster uses ContainerImage.fromAsset which requires Docker.
// Skip this suite when Docker/Finch is unavailable (CI handles it via DinD).
let dockerAvailable = true;
try {
  require('child_process').execSync('finch info 2>/dev/null || docker info 2>/dev/null', { stdio: 'ignore' });
} catch {
  dockerAvailable = false;
}

const describeOrSkip = dockerAvailable ? describe : describe.skip;

describeOrSkip('SandboxCluster', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });

    const vpc = new ec2.Vpc(stack, 'TestVpc', { maxAzs: 2 });
    const containerSg = new ec2.SecurityGroup(stack, 'TestSg', { vpc });

    new SandboxCluster(stack, 'TestCluster', {
      stackPrefix: 'test',
      vpc,
      containerDir: '/dummy',
      image: ecs.ContainerImage.fromRegistry('node:20'),
      containerSg,
      warmPoolSize: 3,
    });

    template = Template.fromStack(stack);
  });

  test('creates ECS cluster with Container Insights', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'test-sandbox-cluster',
      ClusterSettings: [
        {
          Name: 'containerInsights',
          Value: 'enabled',
        },
      ],
    });
  });

  test('creates Fargate task definition with correct CPU and memory', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '12288',
      EphemeralStorage: { SizeInGiB: 30 },
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
    });
  });

  test('task definition has container with correct port mappings', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          Name: 'test-sandbox-container',
          PortMappings: [
            { ContainerPort: 8080, Protocol: 'tcp' },
            { ContainerPort: 3000, Protocol: 'tcp' },
            { ContainerPort: 5173, Protocol: 'tcp' },
          ],
          Essential: true,
          Environment: [
            { Name: 'SESSION_ID', Value: '' },
            { Name: 'PREVIEW_DOMAIN', Value: '' },
          ],
        },
      ],
    });
  });

  test('creates Fargate service with desired count and circuit breaker', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'test-sandbox-service',
      DesiredCount: 3,
      LaunchType: 'FARGATE',
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
        },
      },
    });
  });

  test('service is in private subnets with no public IP', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'DISABLED',
        },
      },
    });
  });

  /**
   * The sidecar reads its own SandboxSession tag to learn which single session
   * it may serve. The Fargate metadata endpoint does not return tags, so the task
   * role needs ListTagsForResource, scoped to this cluster's tasks only, and no
   * permission to change tags.
   */
  test('lets the task read tags of this cluster\'s tasks, and nothing broader', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ecs:ListTagsForResource',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(':task/'), Match.stringLikeRegexp('/\\*$')])],
            },
          }),
        ]),
      },
    });

    const policies = template.findResources('AWS::IAM::Policy');
    const actions = Object.values(policies).flatMap((p: any) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: any) => [].concat(s.Action)),
    );
    expect(actions).not.toContain('ecs:TagResource');
    expect(actions).not.toContain('ecs:UntagResource');
  });

  test('creates CloudWatch log group for containers', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/test-sandbox',
      RetentionInDays: 365,
    });
  });
});
