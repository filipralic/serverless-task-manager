import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ListResult, Task, TaskRepository, UpdateTaskInput, ValidationError } from './model';

export function encodeToken(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;
}

export function decodeToken(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { id?: unknown }).id === 'string') {
      return { id: (parsed as { id: string }).id };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('invalid nextToken');
}

export class DynamoTaskRepository implements TaskRepository {
  constructor(
    private readonly tableName: string,
    private readonly doc: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ) {}

  async create(task: Task): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: task,
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
  }

  async get(id: string): Promise<Task | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { id } }));
    return res.Item as Task | undefined;
  }

  async list(limit: number, nextToken?: string): Promise<ListResult> {
    // Scan is fine for a small personal table; Limit keeps each call well within 1 RCU bursts.
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: limit,
        ExclusiveStartKey: decodeToken(nextToken),
      }),
    );
    return { items: (res.Items ?? []) as Task[], nextToken: encodeToken(res.LastEvaluatedKey) };
  }

  async update(id: string, changes: UpdateTaskInput, updatedAt: string): Promise<Task | undefined> {
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = { ':updatedAt': updatedAt };
    const sets = ['#updatedAt = :updatedAt'];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      names[`#${key}`] = key;
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { id },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes as Task;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tableName, Key: { id }, ConditionExpression: 'attribute_exists(id)' }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
