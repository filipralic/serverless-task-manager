# Serverless Task Manager

Minimal Task Manager API sized for the AWS **Free account plan** (zero charges).

**Resources (eu-north-1):** 1 Lambda (Node.js 22, arm64, 128 MB, 5 s) behind a Function URL
with `AWS_IAM` auth · 1 DynamoDB table (provisioned 1 RCU / 1 WCU, Standard class, AWS-owned key)
· 1 CloudWatch log group (1-day retention) · IAM role/policy. No VPC, NAT, API Gateway, KMS CMK,
alarms, autoscaling, X-Ray, streams or backups.

## API

| Method | Path          | Body                                        | Success |
| ------ | ------------- | ------------------------------------------- | ------- |
| POST   | `/tasks`      | `{ title, description?, status? }`          | 201     |
| GET    | `/tasks`      | query: `limit` (1–50, default 20), `nextToken` | 200  |
| GET    | `/tasks/{id}` |                                             | 200     |
| PUT    | `/tasks/{id}` | any of `{ title, description, status }`     | 200     |
| DELETE | `/tasks/{id}` |                                             | 204     |

`status` is one of `TODO` (default), `IN_PROGRESS`, `DONE`. Errors: 400, 404, 405, 429 (DynamoDB
throttled), 500.

Requests must be SigV4-signed (service `lambda`), e.g.:

```sh
npx awscurl --profile <your-profile> --region eu-north-1 --service lambda \
  -X POST -H 'content-type: application/json' -d '{"title":"Buy milk"}' "$URL/tasks"
```

## Commands

```sh
npm test            # unit tests
npx tsc --noEmit    # type-check
npx cdk synth       # synthesize template (local only)
```

Deploy (creates real resources; requires a one-time `cdk bootstrap`):

```sh
# AWS-managed S3 key, no customer-managed KMS key (this is also the CLI default for a new bootstrap)
npx cdk bootstrap aws://<account-id>/eu-north-1 --profile <your-profile> --bootstrap-kms-key-id AWS_MANAGED_KEY
npx cdk deploy --profile <your-profile>
```

After deploy, attach the `InvokePolicyArn` output (grants `lambda:InvokeFunctionUrl` +
`lambda:InvokeFunction`) to the IAM user/role that will call the API.

## Clean up after testing

```sh
P="--profile <your-profile> --region eu-north-1"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --profile <your-profile>)
BUCKET=cdk-hnb659fds-assets-$ACCOUNT-eu-north-1

# 1. App stack first (it is deleted through the bootstrap's CloudFormation execution role)
npx cdk destroy --profile <your-profile>

# 2. Bootstrap stack (roles, ECR repo, SSM parameter). The S3 bucket has DeletionPolicy: Retain.
aws cloudformation delete-stack --stack-name CDKToolkit $P
aws cloudformation wait stack-delete-complete --stack-name CDKToolkit $P

# 3. The bucket is versioned: delete every object version and delete marker, then the bucket.
#    (`aws s3 rm --recursive` only adds delete markers; it does not remove versions.)
aws s3api list-object-versions --bucket "$BUCKET" $P --output json \
  --query '{Objects: [Versions, DeleteMarkers][].{Key: Key, VersionId: VersionId}}' > /tmp/del.json
grep -q '"Key"' /tmp/del.json && aws s3api delete-objects --bucket "$BUCKET" --delete file:///tmp/del.json $P
aws s3api delete-bucket --bucket "$BUCKET" $P
```

(`delete-objects` takes at most 1000 keys per call; this project uploads 2 objects per deploy.)
