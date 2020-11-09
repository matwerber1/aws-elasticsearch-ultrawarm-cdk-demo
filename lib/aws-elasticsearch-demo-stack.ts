import * as cdk from '@aws-cdk/core';
import * as es from '@aws-cdk/aws-elasticsearch';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import { RemovalPolicy, Tags } from '@aws-cdk/core';
import * as path from 'path';
import * as cloudtrail from '@aws-cdk/aws-cloudtrail';
import * as logs from '@aws-cdk/aws-logs';
import * as lambdaEventSources from '@aws-cdk/aws-lambda-event-sources';
import * as logDestinations from '@aws-cdk/aws-logs-destinations';
import { FilterPattern } from '@aws-cdk/aws-logs';
import { GatewayVpcEndpointAwsService } from '@aws-cdk/aws-ec2';

export class AwsElasticsearchDemoStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const VPC_CIDR = "10.5.0.0/16";
    const DOMAIN_NAME = "es-demo";
    const ACCOUNT = AwsElasticsearchDemoStack.of(this).account;
    const REGION =  AwsElasticsearchDemoStack.of(this).region

    // Create a brand new VPC with two public and private subnets (though our cluster will only use one private subnets)
    const vpc = new ec2.Vpc(this, 'VPC', {
      cidr: VPC_CIDR,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE
        },
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC
        }
      ]
    });

    // Add an S3 VPC Endpoint
    vpc.addGatewayEndpoint('s3-endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Tag everything created by the VPC construct with the name es-demo, except for the subnets: 
    Tags.of(vpc).add('Name', 'es-demo', {
      excludeResourceTypes: ['AWS::EC2::Subnet']
    });

    // Allow private traffic
    const demoSecurityGroup = new ec2.SecurityGroup(this, 'EsDemoSecGroup', {
      vpc: vpc ,
        allowAllOutbound: true,
        securityGroupName: 'es-demo-sg'
    });

    demoSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic());
    //demoSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic()); 
    
    const slowSearchLogGroup = new logs.LogGroup(this, 'EsDemoSlowSearchLogGroup', {
      logGroupName: 'es-demo-slow-search-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const slowIndexLogGroup = new logs.LogGroup(this, 'EsDemoSlowIndexLogGroup', {
      logGroupName: 'es-demo-slow-index-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const appLogGroup = new logs.LogGroup(this, 'EsDemoAppLogGroup', {
      logGroupName: 'es-demo-app-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // The code that defines your stack goes here
    const prodDomain = new es.Domain(this, 'EsDemoDomain', {
      version: es.ElasticsearchVersion.V7_7,
      domainName: DOMAIN_NAME,
      capacity: {
          masterNodes: 3,   // allowed values are 3 or 5; master nodes are required for UltraWarm
          dataNodes: 1,
          dataNodeInstanceType: 'm5.large.elasticsearch',   // T2/T3 instance types are not supported for data nodes that use UltraWarm 
          masterNodeInstanceType: 't3.small.elasticsearch'    

      },
      ebs: {
          volumeSize: 50
      },
      //zoneAwareness: {                    // You could use this if you wanted a multi-AZ deployment....
      //    availabilityZoneCount: 2
      //},
      logging: {
          slowSearchLogEnabled: true,
          appLogEnabled: true,
          slowIndexLogEnabled: true,
          appLogGroup: appLogGroup,
          slowIndexLogGroup: slowIndexLogGroup,
          slowSearchLogGroup: slowSearchLogGroup
      },
      vpcOptions: {
        securityGroups: [
          demoSecurityGroup
        ],
        subnets: [vpc.privateSubnets[0]]      // Since we're only deploying in one AZ, we just pick the first of the two subnets that are created for our cluster
        
      },

      accessPolicies: [                     // Wide-open policy that allows any resource within / connected to our VPC to access the cluster
        new iam.PolicyStatement({
          actions: ["es:*"],
          principals: [
            new iam.AnyPrincipal()
          ],
          resources: [
            `arn:aws:es:${REGION}:${ACCOUNT}:domain/${DOMAIN_NAME}/*`
          ]
        })
      ]
    });

    // Set additional properties not supported by the ES construct: 
    const cfnProdDomain = prodDomain.node.defaultChild as es.CfnDomain;
    cfnProdDomain.addPropertyOverride('ElasticsearchClusterConfig.WarmEnabled', true);
    cfnProdDomain.addPropertyOverride('ElasticsearchClusterConfig.WarmCount', 2);
    cfnProdDomain.addPropertyOverride('ElasticsearchClusterConfig.WarmType', 'ultrawarm1.medium.elasticsearch');

    const cloudTrailLogGroup = new logs.LogGroup(this, 'EsDemoLogGroup', {
      logGroupName: 'es-demo-cloudtrail-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Create a CloudTrail trail to capture API events. We will stream these to our Elasticsearch domain:
    const myTrail = new cloudtrail.Trail(this, "EsDemoCloudTrail", {
      sendToCloudWatchLogs: true, 
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      cloudWatchLogGroup: cloudTrailLogGroup
    });

    // Log all S3 object-level events:
    //myTrail.logAllS3DataEvents();       // This can get expensive if you have a lot of S3 activity. Disabling, for now...

    // Create a Lambda function that will receive CloudTrail logs from a CloudWatch logs group subscription and write to Elasticsearch:
    const lambdaFunction = new lambda.Function(this, 'EsDemoWriteCloudTrailToIndex', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/write-cloudtrail-to-es')),
      runtime: lambda.Runtime.PYTHON_3_8,
      handler: 'app.handler',
      
      environment: {
        ES_REGION: REGION,
        ES_ENDPOINT: `https://${prodDomain.domainEndpoint}`,
        ES_INDEX_PREFIX: 'cloudtrail',
        ES_DOC_TYPE: 'cloudtrail'
      },
      vpc: vpc,
      vpcSubnets: vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE}),
      securityGroups: [
        demoSecurityGroup
      ]
    });

    new logs.SubscriptionFilter(this, 'LambdaLogSubscription', {
      logGroup: cloudTrailLogGroup, 
      destination: new logDestinations.LambdaDestination(lambdaFunction),
      filterPattern: logs.FilterPattern.allEvents()
    });

  }
}
