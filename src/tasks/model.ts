export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status: TaskStatus;
}

export type UpdateTaskInput = Partial<CreateTaskInput>;

export interface ListResult {
  items: Task[];
  nextToken?: string;
}

export interface TaskRepository {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | undefined>;
  list(limit: number, nextToken?: string): Promise<ListResult>;
  /** Returns the updated task, or undefined if it does not exist. */
  update(id: string, changes: UpdateTaskInput, updatedAt: string): Promise<Task | undefined>;
  /** Returns true if a task was deleted, false if it did not exist. */
  delete(id: string): Promise<boolean>;
}

export class ValidationError extends Error {}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('title must be a non-empty string');
  }
  if (value.length > MAX_TITLE) throw new ValidationError(`title must be at most ${MAX_TITLE} characters`);
  return value.trim();
}

function checkDescription(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('description must be a string');
  if (value.length > MAX_DESCRIPTION) {
    throw new ValidationError(`description must be at most ${MAX_DESCRIPTION} characters`);
  }
  return value;
}

function checkStatus(value: unknown): TaskStatus {
  if (typeof value !== 'string' || !(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  return value as TaskStatus;
}

function rejectUnknownFields(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((k) => !['title', 'description', 'status'].includes(k));
  if (unknown.length > 0) throw new ValidationError(`unknown field(s): ${unknown.join(', ')}`);
}

export function parseCreateInput(body: unknown): CreateTaskInput {
  if (!isObject(body)) throw new ValidationError('request body must be a JSON object');
  rejectUnknownFields(body);
  const input: CreateTaskInput = {
    title: checkTitle(body.title),
    status: body.status === undefined ? 'TODO' : checkStatus(body.status),
  };
  if (body.description !== undefined) input.description = checkDescription(body.description);
  return input;
}

export function parseUpdateInput(body: unknown): UpdateTaskInput {
  if (!isObject(body)) throw new ValidationError('request body must be a JSON object');
  rejectUnknownFields(body);
  const input: UpdateTaskInput = {};
  if (body.title !== undefined) input.title = checkTitle(body.title);
  if (body.description !== undefined) input.description = checkDescription(body.description);
  if (body.status !== undefined) input.status = checkStatus(body.status);
  if (Object.keys(input).length === 0) {
    throw new ValidationError('at least one of title, description, status is required');
  }
  return input;
}
