import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as events from 'aws-cdk-lib/aws-events'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'
import { DOMAIN_NAME } from 'haydenturek-constants'

export interface SharedInfraStackProps extends cdk.StackProps {
  appName: string
  environment: string
}

export class SharedInfraStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc
  public readonly eventBus: events.EventBus
  public readonly sharedLogGroup: logs.LogGroup
  public readonly ecsCluster: ecs.Cluster
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer
  public readonly apiGateway: apigateway.RestApi
  public readonly taskExecutionRole: iam.Role
  public readonly serviceRole: iam.Role
  public readonly hostedZone: route53.IHostedZone
  public readonly certificate: acm.Certificate
  public readonly sharedDataBucket: s3.Bucket
  public readonly sharedDataBucketRole: iam.Role

  constructor(scope: Construct, id: string, props: SharedInfraStackProps) {
    super(scope, id, props)

    const { appName, environment } = props
    const domainName = DOMAIN_NAME

    // Create VPC with public and private subnets
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${appName}-${environment}-vpc`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24
        }
      ]
    })

    // Create EventBridge bus for service-to-service communication
    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: `${appName}-${environment}-event-bus`
    })

    // Create shared CloudWatch Log Group
    this.sharedLogGroup = new logs.LogGroup(this, 'SharedLogGroup', {
      logGroupName: `/${appName}/${environment}/shared-logs`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    })

    // // Create ECS Cluster
    // this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
    //   clusterName: `${appName}-${environment}-cluster`,
    //   vpc: this.vpc,
    //   containerInsights: true,
    //   enableFargateCapacityProviders: true
    // })

    // Create shared IAM roles for ECS
    // this.taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
    //   roleName: `${appName}-${environment}-task-execution-role`,
    //   assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    //   managedPolicies: [
    //     iam.ManagedPolicy.fromAwsManagedPolicyName(
    //       'service-role/AmazonECSTaskExecutionRolePolicy'
    //     )
    //   ]
    // })

    // this.serviceRole = new iam.Role(this, 'ServiceRole', {
    //   roleName: `${appName}-${environment}-service-role`,
    //   assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
    //   managedPolicies: [
    //     iam.ManagedPolicy.fromAwsManagedPolicyName(
    //       'service-role/AmazonEC2ContainerServiceRole'
    //     )
    //   ]
    // })

    // Create security groups
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${appName}-${environment}-alb-sg`,
      description: 'Security group for ALB',
      allowAllOutbound: true
    })

    // const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
    //   vpc: this.vpc,
    //   securityGroupName: `${appName}-${environment}-ecs-sg`,
    //   description: 'Security group for ECS tasks',
    //   allowAllOutbound: true
    // })

    // Allow inbound traffic from ALB to ECS tasks
    // ecsSecurityGroup.addIngressRule(
    //   albSecurityGroup,
    //   ec2.Port.tcp(80),
    //   'Allow inbound traffic from ALB'
    // )

    this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: domainName
    })

    // Create ACM certificate
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainName,
      validation: acm.CertificateValidation.fromDns(this.hostedZone)
    })

    // Create Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      'LoadBalancer',
      {
        vpc: this.vpc,
        internetFacing: true,
        securityGroup: albSecurityGroup,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC
        },
        loadBalancerName: `${appName}-${environment}-alb`
      }
    )

    // Create HTTPS listener with the certificate
    const httpsListener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [this.certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Hooked up!'
      })
    })

    // Create HTTP listener that redirects to HTTPS
    this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true
      })
    })

    // Create DNS record for the load balancer
    new route53.ARecord(this, 'LoadBalancerDnsRecord', {
      zone: this.hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(this.loadBalancer)
      ),
      recordName: domainName
    })

    // Create CloudWatch dashboard
    // const dashboard = new cloudwatch.Dashboard(this, 'EcsDashboard', {
    //   dashboardName: `${appName}-${environment}-ecs-dashboard`
    // })

    // // Add cluster metrics to dashboard
    // dashboard.addWidgets(
    //   new cloudwatch.GraphWidget({
    //     title: 'Cluster CPU Utilization',
    //     left: [this.ecsCluster.metricCpuUtilization()]
    //   }),
    //   new cloudwatch.GraphWidget({
    //     title: 'Cluster Memory Utilization',
    //     left: [this.ecsCluster.metricMemoryUtilization()]
    //   })
    // )

    // Create S3 bucket for shared data
    // this.sharedDataBucket = new s3.Bucket(this, 'SharedDataBucket', {
    //   bucketName: `${appName}-${environment}-shared-data`,
    //   encryption: s3.BucketEncryption.S3_MANAGED,
    //   blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    //   versioned: true,
    //   removalPolicy: cdk.RemovalPolicy.RETAIN,
    //   lifecycleRules: [
    //     {
    //       enabled: true,
    //       noncurrentVersionExpiration: cdk.Duration.days(30)
    //     }
    //   ]
    // })

    // Create IAM role for services to access the shared data bucket
    // this.sharedDataBucketRole = new iam.Role(this, 'SharedDataBucketRole', {
    //   roleName: `${appName}-${environment}-shared-data-role`,
    //   assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    //   description: 'Role for services to access shared data bucket'
    // })

    // Add policy to allow read access to the bucket
    // this.sharedDataBucketRole.addToPolicy(
    //   new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     actions: ['s3:GetObject', 's3:ListBucket'],
    //     resources: [
    //       this.sharedDataBucket.bucketArn,
    //       `${this.sharedDataBucket.bucketArn}/*`
    //     ]
    //   })
    // )

    // Import existing OIDC provider for GitHub Actions
    const githubOidcProvider =
      iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'GitHubOidcProvider',
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`
      )

    // Create IAM role for GitHub Actions
    const githubActionsRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: `${appName}-${environment}-github-actions-role`,
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': 'repo:haydenturek/*:*'
          }
        }
      ),
      description: 'Role for GitHub Actions to deploy'
    })

    // Add policy to allow reading CDK bootstrap version
    // githubActionsRole.addToPolicy(
    //   new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     actions: ['ssm:GetParameter'],
    //     resources: [
    //       `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*`
    //     ]
    //   })
    // )

    // Add policy to allow CDK deployment
    githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:*',
          'ec2:*',
          'ecs:*',
          'ecr:*',
          'route53:*',
          'elasticloadbalancing:*',
          'iam:*',
          'logs:*',
          's3:*',
          'secretsmanager:*',
          'ssm:*',
          'bedrock:*',
          'bedrock-runtime:*',
          'stepfunctions:*',
          'events:*',
          'dynamodb:*'
        ],
        resources: ['*']
      })
    )

    new ssm.StringParameter(this, 'VpcId', {
      parameterName: `/${appName}/${environment}/shared-infra/vpc-id`,
      stringValue: this.vpc.vpcId
    })

    // Add VPC subnet exports
    // new cdk.CfnOutput(this, 'VpcAzs', {
    //   value: this.vpc.availabilityZones.join(','),
    //   description: 'VPC Availability Zones',
    //   exportName: `${appName}-${environment}-vpc-azs`
    // })

    // new cdk.CfnOutput(this, 'VpcPrivateSubnets', {
    //   value: this.vpc.privateSubnets.map((subnet) => subnet.subnetId).join(','),
    //   description: 'VPC Private Subnet IDs',
    //   exportName: `${appName}-${environment}-vpc-private-subnets`
    // })

    // new cdk.CfnOutput(this, 'VpcPublicSubnets', {
    //   value: this.vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
    //   description: 'VPC Public Subnet IDs',
    //   exportName: `${appName}-${environment}-vpc-public-subnets`
    // })

    new ssm.StringParameter(this, 'EventBusName', {
      parameterName: `/${appName}/${environment}/shared-infra/event-bus-name`,
      stringValue: this.eventBus.eventBusName
    })

    new ssm.StringParameter(this, 'SharedLogGroupName', {
      parameterName: `/${appName}/${environment}/shared-infra/shared-log-group-name`,
      stringValue: this.sharedLogGroup.logGroupName
    })

    new ssm.StringParameter(this, 'LoadBalancerDns', {
      parameterName: `/${appName}/${environment}/shared-infra/alb-dns`,
      stringValue: this.loadBalancer.loadBalancerDnsName
    })

    new ssm.StringParameter(this, 'LoadBalancerARN', {
      parameterName: `/${appName}/${environment}/shared-infra/alb-arn`,
      stringValue: this.loadBalancer.loadBalancerArn
    })

    new ssm.StringParameter(this, 'HTTPSListenerARN', {
      parameterName: `/${appName}/${environment}/shared-infra/alb-https-listener-arn`,
      stringValue: httpsListener.listenerArn
    })

    new ssm.StringParameter(this, 'CertificateARN', {
      parameterName: `/${appName}/${environment}/shared-infra/certificate-arn`,
      stringValue: this.certificate.certificateArn
    })

    new ssm.StringParameter(this, 'GitHubActionsRoleArn', {
      parameterName: `/${appName}/${environment}/shared-infra/github-actions-role-arn`,
      stringValue: githubActionsRole.roleArn
    })

    cdk.Tags.of(this.loadBalancer).add('Name', `${appName}-${environment}-alb`)
  }
}
