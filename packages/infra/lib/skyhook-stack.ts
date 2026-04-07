import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export class SkyhookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC — 2 public subnets (ALB needs internet-facing), no NAT to save cost
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
      natGateways: 0,
    });

    // ECR Repository for the proxy Docker image
    const repo = new ecr.Repository(this, "ProxyRepo", {
      repositoryName: "skyhook-proxy",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, "ProxyTask", {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDef.addContainer("proxy", {
      image: ecs.ContainerImage.fromEcrRepository(repo, "latest"),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        PORT: "3000",
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "skyhook-proxy",
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
    });

    // Set idle timeout high for long-lived WebSocket connections
    alb.setAttribute("idle_timeout.timeout_seconds", "3600");

    // Fargate Service
    const service = new ecs.FargateService(this, "ProxyService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true, // needed since no NAT gateway
    });

    // Target group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Enable stickiness off (single task for v0, but doesn't hurt)
      stickinessCookieDuration: undefined,
    });

    targetGroup.addTarget(service);

    // Listener
    alb.addListener("HttpListener", {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // Grant ECR pull to task execution role
    repo.grantPull(taskDef.executionRole!);

    // Outputs
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name — use this as the proxy URL",
    });

    new cdk.CfnOutput(this, "EcrRepoUri", {
      value: repo.repositoryUri,
      description: "ECR repository URI for pushing proxy images",
    });

    new cdk.CfnOutput(this, "ProxyUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "Full proxy base URL for MCP clients",
    });

    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: `ws://${alb.loadBalancerDnsName}`,
      description: "WebSocket URL for MCP servers to connect to",
    });
  }
}
