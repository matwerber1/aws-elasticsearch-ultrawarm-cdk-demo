#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { UltraWarmDemoWithExistingVPC } from '../lib/ultrawarm-with-existing-vpc';
import { UltraWarmDemoWithNewVPC } from '../lib/ultrawarm-with-new-vpc';

const app = new cdk.App();

const ENV = {
    region: "us-west-2",
    account: "544941453660"
};

// If you already have a VPC you want to use, set this to false: 
const USE_EXISTING_VPC=true;

if (USE_EXISTING_VPC) {
    new UltraWarmDemoWithExistingVPC(app, 'AwsElasticsearchDemoStack', {
        env: ENV,
        vpcId: 'vpc-0a2cad50c98aed83f',
        privateSubnet1Id: 'subnet-00cffda429f0df548',
        privateSubnet2Id: 'subnet-0c6c99165c3d25c30',
        privateSubnet1AZ: 'us-west-2a',
        privateSubnet2AZ: 'us-west-2b',
        privateSubnet1RouteTableId: 'rtb-070de71135b89465b',
        privateSubnet2RouteTableId: 'rtb-070de71135b89465b'
    });    
} 
else {
    new UltraWarmDemoWithNewVPC(app, 'AwsElasticsearchDemoStack', {
        env: ENV
    }); 
}
