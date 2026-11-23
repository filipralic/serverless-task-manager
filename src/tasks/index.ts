import { createHandler } from './app';
import { DynamoTaskRepository } from './dynamo-repository';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME environment variable is required');

export const handler = createHandler({ repo: new DynamoTaskRepository(tableName) });
