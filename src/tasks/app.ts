import { randomUUID } from 'node:crypto';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';

export type HttpResult = Exclude<LambdaFunctionURLResult, string>;
import { parseCreateInput, parseUpdateInput, Task, TaskRepository, ValidationError } from './model';

const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Deps {
  repo: TaskRepository;
  now?: () => Date;
  newId?: () => string;
}

function json(statusCode: number, body?: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

const error = (statusCode: number, message: string) => json(statusCode, { message });

function readJsonBody(event: LambdaFunctionURLEvent): unknown {
  if (!event.body) throw new ValidationError('request body is required');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new ValidationError('request body too large');
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

export function createHandler(deps: Deps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const { repo } = deps;

  return async (event: LambdaFunctionURLEvent): Promise<HttpResult> => {
    const method = event.requestContext.http.method.toUpperCase();
    const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
    const segments = path.split('/').filter(Boolean);

    try {
      if (segments[0] !== 'tasks' || segments.length > 2) return error(404, 'Not found');

      if (segments.length === 1) {
        if (method === 'POST') {
          const input = parseCreateInput(readJsonBody(event));
          const ts = now().toISOString();
          const task: Task = { id: newId(), ...input, createdAt: ts, updatedAt: ts };
          await repo.create(task);
          return json(201, task);
        }
        if (method === 'GET') {
          const qs = event.queryStringParameters ?? {};
          const result = await repo.list(parseLimit(qs.limit), qs.nextToken);
          return json(200, result);
        }
        return error(405, 'Method not allowed');
      }

      const id = segments[1];
      if (!UUID_RE.test(id)) return error(404, 'Task not found');

      switch (method) {
        case 'GET': {
          const task = await repo.get(id);
          return task ? json(200, task) : error(404, 'Task not found');
        }
        case 'PUT': {
          const changes = parseUpdateInput(readJsonBody(event));
          const task = await repo.update(id, changes, now().toISOString());
          return task ? json(200, task) : error(404, 'Task not found');
        }
        case 'DELETE': {
          const deleted = await repo.delete(id);
          return deleted ? { statusCode: 204 } : error(404, 'Task not found');
        }
        default:
          return error(405, 'Method not allowed');
      }
    } catch (err) {
      if (err instanceof ValidationError) return error(400, err.message);
      if (err instanceof Error && err.name === 'ProvisionedThroughputExceededException') {
        return error(429, 'Too many requests, please retry');
      }
      console.error('Unhandled error', err);
      return error(500, 'Internal server error');
    }
  };
}
