import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SandboxVpcProps {
  stackPrefix: string;
}

export class SandboxVpc extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: SandboxVpcProps) {
    super(scope, id);

    const { stackPrefix } = props;

    // VPC with 2 AZs, public + private subnets, 1 NAT Gateway
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${stackPrefix}-sandbox-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.10.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // Single NAT to save cost
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // VPC Flow Logs to CloudWatch
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      logGroupName: `/aws/vpc/${stackPrefix}-sandbox-vpc/flow-logs`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Tag the VPC
    cdk.Tags.of(this.vpc).add('Name', `${stackPrefix}-sandbox-vpc`);
  }
}
