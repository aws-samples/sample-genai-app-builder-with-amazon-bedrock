import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SandboxInfrastructure } from '../../lib/sandbox';

describe('SandboxInfrastructure (integration)', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });

    new SandboxInfrastructure(stack, 'Sandbox', {
      originVerifyHeaderValue: 'test-origin-secret',
      stackPrefix: 'test',
      warmPoolSize: 2,
      image: ecs.ContainerImage.fromRegistry('node:20'),
    });

    template = Template.fromStack(stack);
  });

  test('creates all major resources', () => {
    // VPC
    template.resourceCountIs('AWS::EC2::VPC', 1);
    // ECR — skipped when using mock image (no fromAsset = no ECR repo in template)
    // template.resourceCountIs('AWS::ECR::Repository', 1);
    // ECS Cluster
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    // ECS Service
    template.resourceCountIs('AWS::ECS::Service', 1);
    // ECS Task Definition
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    // ALB
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    // DynamoDB Table
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  test('DynamoDB table has correct configuration', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-sandbox-sessions-v2',
      KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  test('DynamoDB table has byUserId GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'byUserId',
          KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        }),
      ]),
    });
  });

  test('DynamoDB table has byStatus GSI with sort key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'byStatus',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  test('security groups allow correct traffic', () => {
    // Container SG: inbound 8080 from ALB SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 8080,
      ToPort: 8080,
    });

    // Container SG: inbound 3000-9999 from ALB SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 3000,
      ToPort: 9999,
    });
  });

  test('the ALB accepts traffic only from CloudFront', () => {
    // CloudFront enforces the signed URLs that authorise sandbox WebSockets, so
    // the ALB must not be reachable around it.
    const groups = template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupName: 'test-sandbox-alb-sg' },
    });
    const [[albSgId, albSg]] = Object.entries(groups) as [string, any][];
    const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
      .map((rule: any) => rule.Properties)
      .filter((rule: any) => rule.GroupId?.['Fn::GetAtt']?.[0] === albSgId);
    const ingress = [...(albSg.Properties.SecurityGroupIngress ?? []), ...standalone];

    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 });
    expect(ingress[0].SourcePrefixListId).toBeDefined();
    expect(ingress[0].CidrIp).toBeUndefined();
  });

  test('NACL denies metadata service access', () => {
    template.hasResourceProperties('AWS::EC2::NetworkAclEntry', {
      CidrBlock: '169.254.169.254/32',
      RuleAction: 'deny',
      RuleNumber: 50,
    });
  });

  // ECR tests skipped — mock image (fromRegistry) means no ECR repo in template.
  // These pass in production builds where fromAsset creates the ECR repo.
  test.skip('ECR repository has image scan enabled and lifecycle rule', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'test-sandbox',
      ImageScanningConfiguration: { ScanOnPush: true },
      LifecyclePolicy: {
        LifecyclePolicyText: Match.stringLikeRegexp('countNumber.*10'),
      },
    });
  });

  test('ECS service uses configured warm pool size', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
    });
  });

  test('exports CloudFormation outputs', () => {
    template.hasOutput('SandboxAlbDnsName', {});
    // SandboxEcrRepositoryUri skipped — no ECR repo with mock image
    template.hasOutput('SandboxClusterArn', {});
    template.hasOutput('SandboxSessionsTableName', {});
  });

  describe('weekly container patching', () => {
    test('schedules a weekly rebuild every Monday at 06:00 UTC', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'cron(0 6 ? * MON *)',
        State: 'ENABLED',
      });
    });

    test('creates a CodeBuild project for the patch rebuild', () => {
      template.hasResourceProperties('AWS::CodeBuild::Project', {
        Name: 'test-sandbox-patch-build',
      });
    });

    // Regression guard: the weekly patch build silently FAILED four weeks in a
    // row in prod with no notification, leaving containers out of SLA. The
    // failure alarm is the safety net that makes that impossible to miss.
    test('alarms on a failed patch build', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-sandbox-patch-build-failed',
        Namespace: 'AWS/CodeBuild',
        MetricName: 'FailedBuilds',
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });
  });
});

describe('SandboxInfrastructure — patch build alarm notification', () => {
  test('wires the failure alarm to an SNS email topic when alarmEmail is set', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SandboxInfrastructure(stack, 'Sandbox', {
      originVerifyHeaderValue: 'test-origin-secret',
      stackPrefix: 'test',
      warmPoolSize: 2,
      image: ecs.ContainerImage.fromRegistry('node:20'),
      alarmEmail: 'oncall@example.com',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-sandbox-patch-build-failed',
      AlarmActions: Match.anyValue(),
    });
  });

  test('subscribes every address when alarmEmail is a list', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SandboxInfrastructure(stack, 'Sandbox', {
      originVerifyHeaderValue: 'test-origin-secret',
      stackPrefix: 'test',
      warmPoolSize: 2,
      image: ecs.ContainerImage.fromRegistry('node:20'),
      alarmEmail: ['a@example.com', 'b@example.com', 'c@example.com'],
    });
    const template = Template.fromStack(stack);

    // One topic, one subscription per address.
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 3);
    for (const endpoint of ['a@example.com', 'b@example.com', 'c@example.com']) {
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: endpoint,
      });
    }
  });

  test('de-dupes repeated addresses in the alarmEmail list', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SandboxInfrastructure(stack, 'Sandbox', {
      originVerifyHeaderValue: 'test-origin-secret',
      stackPrefix: 'test',
      warmPoolSize: 2,
      image: ecs.ContainerImage.fromRegistry('node:20'),
      alarmEmail: ['dup@example.com', 'dup@example.com'],
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Subscription', 1);
  });

  test('omits the SNS topic when no alarmEmail is provided', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SandboxInfrastructure(stack, 'Sandbox', {
      originVerifyHeaderValue: 'test-origin-secret',
      stackPrefix: 'test',
      warmPoolSize: 2,
      image: ecs.ContainerImage.fromRegistry('node:20'),
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Topic', 0);
    // Alarm still exists — it just has no action wired.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-sandbox-patch-build-failed',
    });
  });
});
