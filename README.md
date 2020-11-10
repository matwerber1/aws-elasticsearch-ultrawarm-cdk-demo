# Amazon Elasticsearch with UltraWarm - CDK Template

This is a CDK project to automate the creation of a basic Amazon Elasticsearch cluster with UltraWarm. This is for my own learning purposes. This is a test project and certain settings do not follow best practices for production usage. 

Read more about UltraWarm for Amazon Elasticsearch here:

* https://aws.amazon.com/blogs/database/retain-more-for-less-with-ultrawarm-for-amazon-elasticsearch-service/

## Architecture

![diagram](images/diagram.png)

This project deploys:

1. **VPC** a new VPC with a CIDR of 10.5.0.0/16 with two private and public subnets, one NAT Gateway, and an S3 VPC Endpoint.

1. **Elasticsearch cluster** - a new Elasticsearch cluster with three t3.medium master nodes, two m5.large data nodes, and two ultrawarm.medium nodes (See Note 1). The one data node has a 50 GB storage volume. 

1. **CloudTrail** - configures a new trail to send all regional and global management event logs to a CloudWatch Logs group

1. **CloudWatch Logs** - a log group that receives logs from CloudTrail and has an [subscription filter](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html) to send all logs to a Lambda function

1. **Lambda function** - receives CloudWatch Logs via a subscription filter and uses the Elasticsearch PUT/ API to write the logs to an index named `cloudtrail-YYYYMMDD`, where `YYYYMMDD` is the event timestamp per the logs. 

**Note 1** - Ultrawarm can only be used when a cluster has master nodes (3 = minimum) and at least two ultrawarm nodes; also, it does not support data nodes of the T2/T3 type (at this time). The lowest cost data node outside of the T2/T3 nodes is the m5.large.

## Cost

The majority of cost will come from the Elasticsearch cluster itself. For reference, cost in us-west-2 at time of writing is: 

```
  (three t3.medium.elasticsearch master nodes) * ($0.072 / hour) * (744 hours / mo) ~= $160 / mo
+ (two m5.large.elasticsearch data nodes)      * ($0.142 / hour) * (744 hours / mo  ~= $212 / mo
+ (two ultrawarm.medium nodes)                 * ($0.238 / hour) * (744 hours / mo) ~= $354 / mo
 ------------------------------------------------------------------------------------------------
                                                                                   ~= $726 / month ($23 / day)
 ```

Keep in mind, this estimate does not include the cost of CloudTrail, CloudWatch Logs, or the Lambda function... but they should be far lower. I've configured the CloudWatch log groups to only retain logs for one week to help keep log storage low. 

 ## Security

 The Elasticsearch cluster is deployed in a private subnet with a security group that allows all inbound traffic from the VPC CIDR (by default, `10.5.0.0/16`). In production, you might consider stricter security controls.

## Infrastructure Deployment

These instructions are my quick notes to myself. Their not in depth yet and assume you know your way around the AWS CDK.

1. Install and configure the AWS CLI and AWS CDK

1. Clone this project

1. From the project root, install Javascript dependencies for the CDK: `npm install`

1. Install Python dependencies for our Lambda function:

    1. Navigate to `~/lib/lambda/write-cloudtrail-to-es`
    1. Use pyenv and/or virtualenv to use Python version 3.8 (in my case, 3.8.6)
    1. Install Python dependencies: `pip install -r requirements.txt --target .`

1. Deploy the stack: `cdk deploy`

# Elasticsearch Demo APIs with Postman

The file `postman/postman_collection.json` is an importable collection of [Postman](https://www.postman.com/) queries that you can use to test your Elasticsearch cluster.

You don't need to use Postman, but it makes things easier. As an alternative, you could always execute the raw API commands directly from an EC2 or Cloud9 instance in your VPC... but I'll assume you're using Postman.

## Postman Setup

1. Download and install [Postman](https://www.postman.com/)

1. Open Postman and click the **Import** button, then import the collection file at `postman/postman_collection.json`.

1. Configure the endpoint variable to point to your Elasticsearch domain:

    1. Click the elipses symbol near the collection name in Postman
    1. Click **Edit Collection**
    1. Click the **Variables** tab
    1. Set the initial and current value of the `endpoint` variable to your Elasticsearch endpoint. If you have direct access to your VPC (e.g. via a VPN connection), this will just be your cluster endpoint as shown in the Elasticsearch cluster. 
    
    **Or**, if you don't have a VPN connection, you could instead create an SSH tunnel from your local machine through a public EC2 in your VPC by following [these instructions](https://docs.aws.amazon.com/elasticsearch-service/latest/developerguide/es-vpc.html#kibana-test).

    **Or**, you could establish a VPN connection between your local machine and your VPC using [AWS Client VPN](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is.html) (a managed OpenVPN service).

## Postman Queries

This section summarizes the Postman queries available in this demo:

### 01. Get Hot Indexes

**Purpose:** Provides list of all hot indexes, which are those are stored in hot (local EBS or NVMe) storage on your EC2 data nodes. These nodes may be written to.

**API:** `GET {{endpoint}}/_hot`

### 02. Get Warm Indexes

**Purpose:** Provides list of all warm indexes, which are those that are stored by UltraWarm. By default, the data resides in Amazon S3. If the data is queried, it is brought from S3 into a warm cache in your UltraWarm nodes for faster subsequent retrieval. 

**API:** `GET {{endpoint}}/_warm`

### 03. Get Index Summary

**Purpose:** Provides summary info about your indexes
**API:** `GET {{endpoint}}/_cat/indices?v`

**Example Response:**

```
health status index                          uuid                   pri rep docs.count docs.deleted store.size pri.store.size
green  open   cloudtrail-20201109            QlmVqSpPQ32nu6J-ZDre8Q   5   1      20811          541     65.7mb         32.8mb
green  open   .opendistro-job-scheduler-lock AzvJ9HywQmOL4gNlbYPJ3Q   5   1          1            1     34.7kb         17.3kb
green  open   .kibana_1                      ryovaSpsTFGDm6gC92knJg   1   1         58           39    152.6kb         77.7kb
```

### Command...

**Purpose:**
**API:**
