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

interface StackProps extends cdk.StackProps {
  vpcId: string;
  privateSubnet1Id: string;
  privateSubnet2Id: string;
  privateSubnet1AZ: string;
  privateSubnet2AZ: string;
  privateSubnet1RouteTableId: string;
  privateSubnet2RouteTableId: string;
}

export class UltraWarmDemoWithExistingVPC extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const DOMAIN_NAME = "es-demo";
    const ACCOUNT = UltraWarmDemoWithExistingVPC.of(this).account;
    const REGION =  UltraWarmDemoWithExistingVPC.of(this).region

    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVPC', {
      vpcId: props.vpcId
    });
    
    const privateSubnet1 = ec2.Subnet.fromSubnetAttributes(this, "PrivateSubnet1", {
      subnetId: props.privateSubnet1Id,
      availabilityZone: props.privateSubnet1AZ,
      routeTableId: props.privateSubnet1RouteTableId
    });

    const privateSubnet2 = ec2.Subnet.fromSubnetAttributes(this, "PrivateSubnet2", {
      subnetId: props.privateSubnet2Id,
      availabilityZone: props.privateSubnet2AZ,
      routeTableId: props.privateSubnet2RouteTableId
    });

    // Allow private traffic
    const demoSecurityGroup = new ec2.SecurityGroup(this, 'EsDemoSecGroup', {
      vpc: vpc ,
        allowAllOutbound: true,
        securityGroupName: 'ultrawarm-demo-sg'
    });

    // Only allow internal VPC traffic:
    //demoSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic());
    
    // Allow any traffic. Since we (should be) launching this in a private subnet, this should just allow
    // any internal traffic. You could be more specific / secure by scoping this down to your VPC's CIDR, 
    // as in the example above. The reason I'm using this approach is because I am accessing my Elasticsearch
    // VPC from a peered VPC, and rather than complicate this stack by adding more rules (which might not 
    // be applicable to other people using this demo), I've opted for the approach below:
    demoSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic()); 
    
    const slowSearchLogGroup = new logs.LogGroup(this, 'EsDemoSlowSearchLogGroup', {
      logGroupName: 'ultrawarm-demo/slow-search-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const slowIndexLogGroup = new logs.LogGroup(this, 'EsDemoSlowIndexLogGroup', {
      logGroupName: 'ultrawarm-demo/slow-index-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const appLogGroup = new logs.LogGroup(this, 'EsDemoAppLogGroup', {
      logGroupName: 'ultrawarm-demo/app-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Create an elasticsearch cluster
    const prodDomain = new es.Domain(this, 'EsDemoDomain', {
      version: es.ElasticsearchVersion.V7_7,
      domainName: DOMAIN_NAME,
      capacity: {
          masterNodes: 3,   // allowed values are 3 or 5; master nodes are required for UltraWarm
          dataNodes: 2,
          dataNodeInstanceType: 'm5.large.elasticsearch',   // T2/T3 instance types are not supported for data nodes that use UltraWarm 
          masterNodeInstanceType: 't3.medium.elasticsearch'    

      },
      ebs: {
          volumeSize: 50
      },
      zoneAwareness: {              
          availabilityZoneCount: 2
      },
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
        subnets: [
          privateSubnet1,
          privateSubnet2
        ]   
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

    // To enable UltraWarm, set additional properties not supported by the ES CDK construct: 
    const cfnProdDomain = prodDomain.node.defaultChild as es.CfnDomain;
    cfnProdDomain.addPropertyOverride('ElasticsearchClusterConfig.WarmEnabled', true);
    cfnProdDomain.addPropertyOverride('ElasticsearchClusterConfig.WarmCount', 2);
    cfnProdDomain.addPropertyOverride('ElasticsearchClusterConfig.WarmType', 'ultrawarm1.medium.elasticsearch');

    // This is a CloudTrail log group to which CloudTrail will write API events: 
    const cloudTrailLogGroup = new logs.LogGroup(this, 'EsDemoLogGroup', {
      logGroupName: 'ultrawarm-demo/cloudtrail-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // This is the CloudTrail that will log to the log group above:
    const myTrail = new cloudtrail.Trail(this, "EsDemoCloudTrail", {
      sendToCloudWatchLogs: true, 
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      cloudWatchLogGroup: cloudTrailLogGroup
    });

    // Just to give us more sample data, we will also log all S3 object-level events.
    // NOTE - this can be expensive if you have a lot of S3 traffic... not recommended for 
    // production or if you have heavy S3 traffic:
    myTrail.logAllS3DataEvents();       

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
      vpcSubnets: vpc.selectSubnets({
        subnets: [
          privateSubnet1,
          privateSubnet2
        ]
      }),
      securityGroups: [
        demoSecurityGroup
      ]
    });

    // Send all logs from our log group to our Lambda:
    new logs.SubscriptionFilter(this, 'LambdaLogSubscription', {
      logGroup: cloudTrailLogGroup, 
      destination: new logDestinations.LambdaDestination(lambdaFunction),
      filterPattern: logs.FilterPattern.allEvents()
    });

  }
}
