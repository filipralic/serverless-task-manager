#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ServerlessTaskManagerStack } from '../lib/serverless-task-manager-stack';

const app = new cdk.App();
new ServerlessTaskManagerStack(app, 'ServerlessTaskManagerStack', {
  // Region is pinned; the account comes from the CLI profile (use `--profile <your-profile>`).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-north-1' },
});
