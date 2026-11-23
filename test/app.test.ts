import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { createHandler } from '../src/tasks/app';
import { ListResult, Task, TaskRepository, UpdateTaskInput } from '../src/tasks/model';

class InMemoryRepo implements TaskRepository {
  tasks = new Map<string, Task>();
  async create(task: Task) {
    this.tasks.set(task.id, task);
  }
  async get(id: string) {
    return this.tasks.get(id);
  }
  async list(limit: number, _nextToken?: string): Promise<ListResult> {
    return { items: [...this.tasks.values()].slice(0, limit) };
  }
  async update(id: string, changes: UpdateTaskInput, updatedAt: string) {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated = { ...t, ...changes, updatedAt };
    this.tasks.set(id, updated);
    return updated;
  }
  async delete(id: string) {
    return this.tasks.delete(id);
  }
}

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-2222-4333-8444-555555555555';

function event(method: string, rawPath: string, body?: unknown, qs?: Record<string, string>): LambdaFunctionURLEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {},
    queryStringParameters: qs,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method, path: rawPath } },
  } as unknown as LambdaFunctionURLEvent;
}

function setup() {
  const repo = new InMemoryRepo();
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const handler = createHandler({
    repo,
    newId: () => ID,
    now: () => new Date((clock += 1000)),
  });
  return { repo, handler };
}

const parse = (r: { body?: string }) => (r.body ? JSON.parse(r.body) : undefined);

describe('POST /tasks', () => {
  test('creates a task with defaults', async () => {
    const { handler, repo } = setup();
    const res = await handler(event('POST', '/tasks', { title: '  Buy milk ' }));
    expect(res.statusCode).toBe(201);
    expect(parse(res)).toEqual({
      id: ID,
      title: 'Buy milk',
      status: 'TODO',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(repo.tasks.size).toBe(1);
  });

  test('accepts description and status, and base64 bodies', async () => {
    const { handler } = setup();
    const body = Buffer.from(JSON.stringify({ title: 'a', description: 'b', status: 'DONE' })).toString('base64');
    const res = await handler({ ...event('POST', '/tasks', body), isBase64Encoded: true });
    expect(res.statusCode).toBe(201);
    expect(parse(res)).toMatchObject({ description: 'b', status: 'DONE' });
  });

  test.each([
    ['missing body', undefined, 'request body is required'],
    ['invalid JSON', '{nope', 'request body must be valid JSON'],
    ['array body', [], 'request body must be a JSON object'],
    ['missing title', {}, 'title must be a non-empty string'],
    ['blank title', { title: '   ' }, 'title must be a non-empty string'],
    ['long title', { title: 'x'.repeat(201) }, 'title must be at most 200 characters'],
    ['bad status', { title: 'a', status: 'NOPE' }, 'status must be one of TODO, IN_PROGRESS, DONE'],
    ['bad description', { title: 'a', description: 5 }, 'description must be a string'],
    ['unknown field', { title: 'a', id: 'x' }, 'unknown field(s): id'],
    ['too large', { title: 'a', description: 'x'.repeat(9000) }, 'request body too large'],
  ])('rejects %s with 400', async (_name, body, message) => {
    const { handler, repo } = setup();
    const res = await handler(event('POST', '/tasks', body));
    expect(res.statusCode).toBe(400);
    expect(parse(res)).toEqual({ message });
    expect(repo.tasks.size).toBe(0);
  });
});

describe('GET /tasks', () => {
  test('lists tasks', async () => {
    const { handler } = setup();
    await handler(event('POST', '/tasks', { title: 'a' }));
    const res = await handler(event('GET', '/tasks/'));
    expect(res.statusCode).toBe(200);
    expect(parse(res).items).toHaveLength(1);
  });

  test('passes limit and nextToken to the repository', async () => {
    const { handler, repo } = setup();
    const spy = jest.spyOn(repo, 'list');
    await handler(event('GET', '/tasks', undefined, { limit: '5', nextToken: 'abc' }));
    expect(spy).toHaveBeenCalledWith(5, 'abc');
  });

  test.each(['0', '51', '2.5', 'x'])('rejects limit=%s', async (limit) => {
    const { handler } = setup();
    const res = await handler(event('GET', '/tasks', undefined, { limit }));
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /tasks/{id}', () => {
  test('returns the task', async () => {
    const { handler } = setup();
    await handler(event('POST', '/tasks', { title: 'a' }));
    const res = await handler(event('GET', `/tasks/${ID}`));
    expect(res.statusCode).toBe(200);
    expect(parse(res).id).toBe(ID);
  });

  test('404 for unknown or malformed id', async () => {
    const { handler } = setup();
    expect((await handler(event('GET', `/tasks/${OTHER_ID}`))).statusCode).toBe(404);
    expect((await handler(event('GET', '/tasks/not-a-uuid'))).statusCode).toBe(404);
  });
});

describe('PUT /tasks/{id}', () => {
  test('updates provided fields and updatedAt', async () => {
    const { handler } = setup();
    await handler(event('POST', '/tasks', { title: 'a' }));
    const res = await handler(event('PUT', `/tasks/${ID}`, { status: 'IN_PROGRESS' }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toMatchObject({
      title: 'a',
      status: 'IN_PROGRESS',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
    });
  });

  test('400 for empty update', async () => {
    const { handler } = setup();
    await handler(event('POST', '/tasks', { title: 'a' }));
    const res = await handler(event('PUT', `/tasks/${ID}`, {}));
    expect(res.statusCode).toBe(400);
  });

  test('404 for unknown task', async () => {
    const { handler } = setup();
    const res = await handler(event('PUT', `/tasks/${OTHER_ID}`, { title: 'b' }));
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /tasks/{id}', () => {
  test('deletes and returns 204, then 404', async () => {
    const { handler, repo } = setup();
    await handler(event('POST', '/tasks', { title: 'a' }));
    const res = await handler(event('DELETE', `/tasks/${ID}`));
    expect(res.statusCode).toBe(204);
    expect(repo.tasks.size).toBe(0);
    expect((await handler(event('DELETE', `/tasks/${ID}`))).statusCode).toBe(404);
  });
});

describe('routing and errors', () => {
  test.each([
    ['GET', '/'],
    ['GET', '/other'],
    ['GET', `/tasks/${ID}/extra`],
  ])('%s %s -> 404', async (method, path) => {
    const { handler } = setup();
    expect((await handler(event(method, path))).statusCode).toBe(404);
  });

  test.each([
    ['DELETE', '/tasks'],
    ['PATCH', `/tasks/${ID}`],
    ['POST', `/tasks/${ID}`],
  ])('%s %s -> 405', async (method, path) => {
    const { handler } = setup();
    expect((await handler(event(method, path))).statusCode).toBe(405);
  });

  test('maps DynamoDB throttling to 429', async () => {
    const { handler, repo } = setup();
    const err = Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    jest.spyOn(repo, 'get').mockRejectedValue(err);
    expect((await handler(event('GET', `/tasks/${ID}`))).statusCode).toBe(429);
  });

  test('unexpected errors -> 500 without leaking details', async () => {
    const { handler, repo } = setup();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(repo, 'get').mockRejectedValue(new Error('secret detail'));
    const res = await handler(event('GET', `/tasks/${ID}`));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
  });
});
