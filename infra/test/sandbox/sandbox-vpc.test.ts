import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SandboxVpc } from '../../lib/sandbox/sandbox-vpc';

describe('SandboxVpc', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new SandboxVpc(stack, 'TestVpc', { stackPrefix: 'test' });
    template = Template.fromStack(stack);
  });

  test('creates a VPC with correct CIDR', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.10.0.0/16',
    });
  });

  test('creates exactly 1 NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('creates subnets in 2 AZs (4 subnets total: 2 public + 2 private)', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('creates VPC flow logs to CloudWatch', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      ResourceType: 'VPC',
      TrafficType: 'ALL',
      LogDestinationType: 'cloud-watch-logs',
    });
  });

  test('creates CloudWatch log group for flow logs', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/vpc/test-sandbox-vpc/flow-logs',
      RetentionInDays: 30,
    });
  });
});
