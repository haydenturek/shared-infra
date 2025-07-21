#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { SharedInfraStack } from '../lib/shared-infra-stack'

const app = new cdk.App()

const env = app.node.tryGetContext('environment') || 'dev'
const appName = 'haydenturek'

new SharedInfraStack(app, `${appName}-${env}-shared-infra`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
  },
  appName,
  environment: env,
  description: `Shared infrastructure for ${appName} ${env} environment`
})
