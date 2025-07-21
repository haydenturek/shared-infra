#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { SharedInfraStack } from '../lib/shared-infra-stack'
import { APP_NAME } from 'haydenturek-constants'

const app = new cdk.App()

const env = app.node.tryGetContext('environment') || 'dev'
const appName = APP_NAME

new SharedInfraStack(app, `${appName}-${env}-shared-infra`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
  },
  appName,
  environment: env,
  description: `Shared infrastructure for ${appName} ${env} environment`
})
