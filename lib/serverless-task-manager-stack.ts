import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Smallest-footprint Task Manager API, sized to stay inside the AWS always-free limits:
 * one Lambda (Function URL, AWS_IAM auth), one DynamoDB table (1 RCU / 1 WCU fixed),
 * one CloudWatch log group (1 day retention). No VPC, NAT, API Gateway, KMS CMK,
 * alarms, autoscaling, X-Ray, streams or backups.
 */
export class ServerlessTaskManagerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Table (v1) is used on purpose: TableV2 provisioned billing forces autoscaled write capacity,
    // which would add Application Auto Scaling + CloudWatch alarms.
    const table = new dynamodb.Table(this, 'TasksTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      tableClass: dynamodb.TableClass.STANDARD, // free tier applies only to Standard class
      encryption: dynamodb.TableEncryption.DEFAULT, // AWS-owned key, no KMS charges
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // `cdk destroy` leaves nothing behind
    });

    const logGroup = new logs.LogGroup(this, 'TasksFunctionLogs', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new nodejs.NodejsFunction(this, 'TasksFunction', {
      entry: path.join(__dirname, '..', 'src', 'tasks', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      logGroup,
      environment: { TABLE_NAME: table.tableName },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/*'], // provided by the Node.js 22 runtime
      },
    });

    // Least privilege: exactly the operations used in src/tasks/dynamo-repository.ts.
    // (grantReadWriteData would also add Batch*, Query, ConditionCheckItem, DescribeTable, streams.)
    table.grant(
      fn,
      'dynamodb:PutItem',
      'dynamodb:GetItem',
      'dynamodb:Scan',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // Same-account callers are authorised by their identity policy. Since Oct 2025 a Function URL
    // call needs BOTH lambda:InvokeFunctionUrl and lambda:InvokeFunction. Attach this (free)
    // managed policy to the IAM user/role that will call the API.
    const invokePolicy = new iam.ManagedPolicy(this, 'TasksApiInvokePolicy', {
      description: 'Allows calling the Task Manager Function URL (SigV4, AWS_IAM auth).',
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeFunctionUrl',
          actions: ['lambda:InvokeFunctionUrl'],
          resources: [fn.functionArn],
          conditions: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
        }),
        new iam.PolicyStatement({
          sid: 'InvokeFunctionViaUrlOnly',
          actions: ['lambda:InvokeFunction'],
          resources: [fn.functionArn],
          conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
        }),
      ],
    });

    new cdk.CfnOutput(this, 'FunctionUrl', { value: fnUrl.url });
    new cdk.CfnOutput(this, 'InvokePolicyArn', { value: invokePolicy.managedPolicyArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
