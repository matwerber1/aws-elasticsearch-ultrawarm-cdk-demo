#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsElasticsearchDemoStack } from '../lib/aws-elasticsearch-demo-stack';

const app = new cdk.App();
new AwsElasticsearchDemoStack(app, 'AwsElasticsearchDemoStack');
