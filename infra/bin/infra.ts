#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

const app = new cdk.App();

// Load configuration (CONFIG_FILE env var for prod, defaults to config.yml for dev)
const configFile = process.env.CONFIG_FILE || 'config.yml';
const configPath = path.join(__dirname, '..', configFile);
const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as {
  stackName: string;
  region: string;
  bedrockModelId: string;
  extractionModelId?: string;
  cognitoUsers?: string[];
  customDomain?: string;
};

new InfraStack(app, config.stackName, {
  env: {
    region: config.region,
    account: process.env.CDK_DEFAULT_ACCOUNT, // Required for Route53 hosted zone lookup
  },
  config: config,
});