import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface SandboxSecurityProps {
  stackPrefix: string;
  vpc: ec2.IVpc;
}

export class SandboxSecurity extends Construct {
  public readonly albSg: ec2.SecurityGroup;
  public readonly containerSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SandboxSecurityProps) {
    super(scope, id);

    const { stackPrefix, vpc } = props;

    // ALB Security Group: inbound from CloudFront only
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      securityGroupName: `${stackPrefix}-sandbox-alb-sg`,
      description: 'Security group for sandbox ALB',
      allowAllOutbound: false,
    });

    // Inbound only from CloudFront's origin-facing addresses, via the AWS-managed
    // prefix list. CloudFront is the only intended way in: it enforces the signed
    // URLs that authorise sandbox WebSocket upgrades, so a load balancer reachable
    // from anywhere would let a caller skip that check entirely. Requests from
    // other CloudFront distributions are refused by the origin-verify header that
    // every forwarding rule requires (see sandbox-alb.ts).
    //
    // A single rule, because the prefix list counts as its maximum entry count
    // against the security group's rules quota. Port 80 is not opened: CloudFront
    // reaches the ALB on 443 only.
    const cloudFrontOriginFacing = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    });

    this.albSg.addIngressRule(
      ec2.Peer.prefixList(cloudFrontOriginFacing.prefixListId),
      ec2.Port.tcp(443),
      'Allow HTTP on 443 from CloudFront only',
    );

    // ALB needs outbound to containers
    this.albSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow outbound to container sidecar',
    );

    this.albSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcpRange(3000, 9999),
      'Allow outbound to container dev server ports',
    );

    // Container Security Group
    this.containerSg = new ec2.SecurityGroup(this, 'ContainerSg', {
      vpc,
      securityGroupName: `${stackPrefix}-sandbox-container-sg`,
      description: 'Security group for sandbox Fargate containers',
      allowAllOutbound: false,
    });

    // Inbound: 8080 from ALB (sidecar)
    this.containerSg.addIngressRule(
      this.albSg,
      ec2.Port.tcp(8080),
      'Allow sidecar traffic from ALB',
    );

    // Inbound: 3000-9999 from ALB (dev server ports)
    this.containerSg.addIngressRule(
      this.albSg,
      ec2.Port.tcpRange(3000, 9999),
      'Allow dev server traffic from ALB',
    );

    // Outbound: 443 only (npm registry, etc.)
    this.containerSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound for npm registry',
    );

    // NACL on private subnets: DENY metadata service
    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });

    const nacl = new ec2.NetworkAcl(this, 'PrivateNacl', {
      vpc,
      networkAclName: `${stackPrefix}-sandbox-private-nacl`,
      subnetSelection: { subnets: privateSubnets.subnets },
    });

    // DENY outbound to metadata service (169.254.169.254)
    nacl.addEntry('DenyMetadataOutbound', {
      cidr: ec2.AclCidr.ipv4('169.254.169.254/32'),
      ruleNumber: 50,
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.DENY,
    });

    // DENY inbound from metadata service
    nacl.addEntry('DenyMetadataInbound', {
      cidr: ec2.AclCidr.ipv4('169.254.169.254/32'),
      ruleNumber: 50,
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.INGRESS,
      ruleAction: ec2.Action.DENY,
    });

    // ALLOW all other traffic (lower priority)
    nacl.addEntry('AllowAllOutbound', {
      cidr: ec2.AclCidr.anyIpv4(),
      ruleNumber: 100,
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
    });

    nacl.addEntry('AllowAllInbound', {
      cidr: ec2.AclCidr.anyIpv4(),
      ruleNumber: 100,
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.INGRESS,
      ruleAction: ec2.Action.ALLOW,
    });
  }
}
