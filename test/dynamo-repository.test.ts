import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { decodeToken, DynamoTaskRepository, encodeToken } from '../src/tasks/dynamo-repository';
import { ValidationError } from '../src/tasks/model';

const ccf = () => new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });

function setup() {
  const send = jest.fn();
  const repo = new DynamoTaskRepository('Tasks', { send } as unknown as DynamoDBDocumentClient);
  return { send, repo };
}

const task = {
  id: 'a',
  title: 't',
  status: 'TODO' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('create uses a conditional put', async () => {
  const { send, repo } = setup();
  send.mockResolvedValue({});
  await repo.create(task);
  const cmd = send.mock.calls[0][0];
  expect(cmd).toBeInstanceOf(PutCommand);
  expect(cmd.input).toEqual({ TableName: 'Tasks', Item: task, ConditionExpression: 'attribute_not_exists(id)' });
});

test('get returns the item', async () => {
  const { send, repo } = setup();
  send.mockResolvedValue({ Item: task });
  expect(await repo.get('a')).toEqual(task);
  expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  expect(send.mock.calls[0][0].input).toEqual({ TableName: 'Tasks', Key: { id: 'a' } });
});

test('list scans with limit and round-trips the pagination token', async () => {
  const { send, repo } = setup();
  send.mockResolvedValueOnce({ Items: [task], LastEvaluatedKey: { id: 'a' } });
  const page1 = await repo.list(10);
  expect(send.mock.calls[0][0]).toBeInstanceOf(ScanCommand);
  expect(send.mock.calls[0][0].input).toEqual({ TableName: 'Tasks', Limit: 10, ExclusiveStartKey: undefined });
  expect(page1).toEqual({ items: [task], nextToken: encodeToken({ id: 'a' }) });

  send.mockResolvedValueOnce({});
  const page2 = await repo.list(10, page1.nextToken);
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ id: 'a' });
  expect(page2).toEqual({ items: [], nextToken: undefined });
});

test('decodeToken rejects garbage', () => {
  expect(() => decodeToken('!!!')).toThrow(ValidationError);
  expect(() => decodeToken(Buffer.from('{"x":1}').toString('base64url'))).toThrow(ValidationError);
  expect(decodeToken(undefined)).toBeUndefined();
});

test('update builds a conditional SET expression for provided fields only', async () => {
  const { send, repo } = setup();
  send.mockResolvedValue({ Attributes: { ...task, status: 'DONE' } });
  const result = await repo.update('a', { status: 'DONE', title: undefined }, '2026-02-01T00:00:00.000Z');
  const cmd = send.mock.calls[0][0];
  expect(cmd).toBeInstanceOf(UpdateCommand);
  expect(cmd.input).toEqual({
    TableName: 'Tasks',
    Key: { id: 'a' },
    UpdateExpression: 'SET #updatedAt = :updatedAt, #status = :status',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeNames: { '#updatedAt': 'updatedAt', '#status': 'status' },
    ExpressionAttributeValues: { ':updatedAt': '2026-02-01T00:00:00.000Z', ':status': 'DONE' },
    ReturnValues: 'ALL_NEW',
  });
  expect(result?.status).toBe('DONE');
});

test('update returns undefined when the task does not exist', async () => {
  const { send, repo } = setup();
  send.mockRejectedValue(ccf());
  expect(await repo.update('a', { title: 'x' }, 'now')).toBeUndefined();
});

test('delete returns true/false based on existence', async () => {
  const { send, repo } = setup();
  send.mockResolvedValueOnce({});
  expect(await repo.delete('a')).toBe(true);
  expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteCommand);
  send.mockRejectedValueOnce(ccf());
  expect(await repo.delete('a')).toBe(false);
});

test('other errors propagate', async () => {
  const { send, repo } = setup();
  send.mockRejectedValue(new Error('boom'));
  await expect(repo.delete('a')).rejects.toThrow('boom');
  await expect(repo.update('a', { title: 'x' }, 'now')).rejects.toThrow('boom');
});
