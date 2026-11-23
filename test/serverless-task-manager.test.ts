import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ServerlessTaskManagerStack } from '../lib/serverless-task-manager-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new ServerlessTaskManagerStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  template = Template.fromStack(stack);
});

test('only the expected (free-tier) resource types are created', () => {
  const types = new Set(Object.values(template.toJSON().Resources).map((r: any) => r.Type));
  expect([...types].sort()).toEqual(
    [
      'AWS::DynamoDB::Table',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::Policy',
      'AWS::IAM::Role',
      'AWS::Lambda::Function',
      'AWS::Lambda::Url',
      'AWS::Logs::LogGroup',
    ].sort(),
  );
});

test('DynamoDB table uses fixed 1 RCU / 1 WCU provisioned capacity, no paid extras', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Delete',
    Properties: {
      BillingMode: Match.absent(),
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      SSESpecification: { SSEEnabled: false }, // AWS-owned key (free); true would mean KMS
      StreamSpecification: Match.absent(),
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      TableClass: 'STANDARD',
    },
  });
  template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
});

test('Lambda: Node.js 22, arm64, 128 MB, 5 s, no VPC/tracing/reserved concurrency', () => {
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    MemorySize: 128,
    Timeout: 5,
    VpcConfig: Match.absent(),
    TracingConfig: Match.absent(),
    Layers: Match.absent(),
    ReservedConcurrentExecutions: Match.absent(),
    Environment: { Variables: { TABLE_NAME: Match.anyValue() } },
    LoggingConfig: { LogGroup: Match.anyValue() },
  });
});

test('Function URL uses AWS_IAM auth', () => {
  template.resourceCountIs('AWS::Lambda::Url', 1);
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  template.hasOutput('FunctionUrl', {});
});

test('log group retains logs for 1 day and is deleted with the stack', () => {
  template.resourceCountIs('AWS::Logs::LogGroup', 1);
  template.hasResource('AWS::Logs::LogGroup', {
    DeletionPolicy: 'Delete',
    Properties: { RetentionInDays: 1, KmsKeyId: Match.absent() },
  });
});

test('Lambda role gets exactly the DynamoDB actions the code uses, on the tasks table only', () => {
  template.resourceCountIs('AWS::IAM::Policy', 1);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'dynamodb:PutItem',
            'dynamodb:GetItem',
            'dynamodb:Scan',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
          ],
          Resource: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('TasksTable'), 'Arn'] }],
        },
      ],
    },
  });
});

test('no customer-managed KMS keys anywhere', () => {
  template.resourceCountIs('AWS::KMS::Key', 0);
  const json = JSON.stringify(template.toJSON());
  expect(json).not.toMatch(/KMSMasterKeyId|KmsKeyId|"SSEType"/);
});

test('caller policy grants both InvokeFunctionUrl and InvokeFunction (URL-only) on the function', () => {
  const fnArn = { 'Fn::GetAtt': [Match.stringLikeRegexp('TasksFunction'), 'Arn'] };
  template.resourceCountIs('AWS::IAM::ManagedPolicy', 1);
  template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    Roles: Match.absent(),
    Users: Match.absent(),
    PolicyDocument: {
      Statement: [
        {
          Sid: 'InvokeFunctionUrl',
          Effect: 'Allow',
          Action: 'lambda:InvokeFunctionUrl',
          Resource: fnArn,
          Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
        },
        {
          Sid: 'InvokeFunctionViaUrlOnly',
          Effect: 'Allow',
          Action: 'lambda:InvokeFunction',
          Resource: fnArn,
          Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
        },
      ],
    },
  });
  // No resource policy: the URL is not opened to other principals/accounts.
  template.resourceCountIs('AWS::Lambda::Permission', 0);
});
