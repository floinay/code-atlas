import { Model, buildView, lineage, type Edge, type Element } from '@code-atlas/model';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createExpressPrismaExtractor, detectExpressPrisma, parsePrismaSchema } from '../src/index.ts';

const root = fileURLToPath(new URL('../../../examples/express-prisma', import.meta.url));
const { model, stats } = createExpressPrismaExtractor(root).extract();
Model.parse(model);

const byId = new Map(model.elements.map((e) => [e.id, e]));
const find = <K extends Element['kind']>(kind: K, name: string) => {
  const found = model.elements.find((e) => e.kind === kind && (e.name === name || e.label === name));
  if (!found) throw new Error(`no ${kind} named ${name}`);
  return found as Extract<Element, { kind: K }>;
};
const labels = (edges: Edge[], end: 'source' | 'target') => edges.map((e) => byId.get(e[end])!.label).sort();
const out = (id: string, kind: Edge['kind']) => labels(model.edges.filter((e) => e.source === id && e.kind === kind), 'target');
const into = (id: string, kind: Edge['kind']) => labels(model.edges.filter((e) => e.target === id && e.kind === kind), 'source');

describe('taskboard: an Express + Prisma app', () => {
  it('is detected, and a Yeda repository is not', () => {
    expect(detectExpressPrisma(root)).toBe(true);
    expect(detectExpressPrisma(fileURLToPath(new URL('../../extractor-yeda/test/fixtures/mini', import.meta.url)))).toBe(false);
  });

  it('maps modules to domains', () => {
    expect(model.repo).toEqual({ name: 'taskboard', adapter: 'express-prisma' });
    expect(model.domains).toEqual([
      { id: 'app', name: 'App', path: 'src' },
      { id: 'projects', name: 'Projects', path: 'src/modules/projects' },
      { id: 'tasks', name: 'Tasks', path: 'src/modules/tasks' },
      { id: 'users', name: 'Users', path: 'src/modules/users' },
    ]);
    expect(stats.files).toBeGreaterThan(10);
  });

  it('uses only the lanes a CRUD app has: command → table → query', () => {
    const kinds = new Set(model.elements.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['command', 'external', 'query', 'table', 'worker']);
    expect(new Set(model.edges.map((e) => e.kind))).toEqual(new Set(['writes', 'reads', 'calls']));
    expect(model.checks).toEqual([]);
  });

  it('gives every element and edge evidence that exists', () => {
    for (const item of [...model.elements, ...model.edges]) {
      expect(existsSync(`${root}/${item.evidence.file}`), item.evidence.file).toBe(true);
      expect(item.evidence.line).toBeGreaterThan(0);
    }
  });
});

describe('routes', () => {
  it('resolves the full path through nested routers', () => {
    expect(find('query', 'listTasks').http).toEqual({ method: 'GET', path: '/api/projects/:projectId/tasks' });
    expect(find('command', 'inviteUser').http).toEqual({ method: 'POST', path: '/api/users' });
    expect(find('query', 'GET /health').http?.path).toBe('/health');
  });

  it('reads router.route(path).get().patch() chains', () => {
    expect(find('query', 'getProject').name).toBe('GET /api/projects/:projectId');
    expect(find('command', 'renameProject').name).toBe('PATCH /api/projects/:projectId');
  });

  it('names an inline handler after the service function it calls', () => {
    const tasks = model.elements.filter((e) => e.domain === 'tasks' && (e.kind === 'command' || e.kind === 'query'));
    expect(tasks.map((e) => e.label).sort()).toEqual([
      'addComment', 'createTask', 'deleteTask', 'getTask', 'listComments', 'listTasks', 'moveTask', 'searchTasks', 'updateTask',
    ]);
  });

  it('decides command or query by what the handler does, not by the HTTP verb', () => {
    // A POST that only reads.
    expect(find('query', 'searchTasks').http?.method).toBe('POST');
    expect(find('command', 'moveTask').http?.method).toBe('POST');
    expect(find('command', 'removeUser').http?.method).toBe('DELETE');
  });

  it('collects guards from the router and from the route', () => {
    expect(find('query', 'listUsers').permission).toBe('requireAuth');
    expect(find('command', 'inviteUser').permission).toBe("requireAuth + requireRole('admin')");
    expect(find('query', 'GET /health').permission).toBeUndefined();
  });

  it('reads the input: path parameters and the Zod schema the body is parsed with', () => {
    expect(find('command', 'createTask').input).toEqual({
      type: '{ projectId, …CreateTask }',
      refs: ['CreateTask'],
      fields: [
        { name: 'projectId', type: 'string', optional: false, note: 'path', refs: [] },
        { name: '…', type: 'CreateTask', optional: false, note: 'body', refs: ['CreateTask'] },
      ],
    });
    expect(model.types['CreateTask']?.fields).toEqual([
      { name: 'title', type: 'string', optional: false, note: '1–200', refs: [] },
      { name: 'assigneeId', type: 'string', optional: true, refs: [] },
      { name: 'dueAt', type: 'datetime', optional: true, refs: [] },
    ]);
    // CreateProject.pick({ name: true })
    expect(model.types['RenameProject']?.fields?.map((f) => f.name)).toEqual(['name']);
    expect(find('query', 'listUsers').input).toBeUndefined();
  });

  it('types responses from the Prisma call behind them', () => {
    expect(find('query', 'listTasks').responses).toEqual([{ status: 200, body: { type: 'Task[]', refs: ['Task'] } }]);
    expect(find('query', 'getTask').responses).toEqual([{ status: 200, body: { type: 'Task | null', refs: ['Task'] } }]);
    expect(find('command', 'createTask').responses).toEqual([{ status: 201, body: { type: 'Task', refs: ['Task'] } }]);
    expect(find('command', 'deleteTask').responses).toEqual([{ status: 204, body: { type: 'void', refs: [] } }]);
    expect(find('query', 'GET /health').responses[0]?.body.type).toBe('{ ok }');
    expect(model.types['Task']?.fields?.map((f) => f.name)).toEqual([
      'id', 'projectId', 'assigneeId', 'title', 'status', 'dueAt', 'updatedAt', 'project', 'assignee', 'comments',
    ]);
  });

  it('collects error statuses and codes, including those of the guards', () => {
    expect(find('query', 'getTask').errors).toEqual({ statuses: [401, 404], codes: ['unauthenticated', 'task_not_found'] });
    expect(find('command', 'inviteUser').errors).toEqual({ statuses: [401, 403], codes: ['unauthenticated', 'forbidden'] });
  });

  it('keeps the JSDoc of a route as its description', () => {
    expect(find('command', 'archiveProject').description).toBe('Archived projects leave the lists; nothing is deleted.');
  });
});

describe('tables', () => {
  it('reads Prisma models as tables, with mapped names', () => {
    const tasks = find('table', 'tasks');
    expect(tasks.domain).toBe('tasks');
    expect(tasks.columns).toEqual([
      { name: 'id', type: 'String', primaryKey: true, notNull: true, note: 'default cuid()' },
      { name: 'project_id', type: 'String', primaryKey: false, notNull: true },
      { name: 'assignee_id', type: 'String', primaryKey: false, notNull: false },
      { name: 'title', type: 'String', primaryKey: false, notNull: true },
      { name: 'status', type: 'TaskStatus', primaryKey: false, notNull: true, note: 'default todo' },
      { name: 'due_at', type: 'DateTime', primaryKey: false, notNull: false },
      { name: 'updated_at', type: 'DateTime', primaryKey: false, notNull: true, note: 'updated automatically' },
    ]);
    expect(tasks.primaryKey).toEqual(['id']);
    expect(tasks.indexes).toEqual([{ name: 'project_id_status_idx', columns: ['project_id', 'status'], unique: false }]);
    expect(tasks.evidence).toEqual({ file: 'prisma/schema.prisma', line: 60 });
  });

  it('reads composite keys and unique fields', () => {
    expect(find('table', 'project_members').primaryKey).toEqual(['project_id', 'user_id']);
    expect(find('table', 'users').indexes).toEqual([{ name: 'email_key', columns: ['email'], unique: true }]);
  });

  it('puts a table in the module named after it, else in the one that writes it most', () => {
    expect(find('table', 'projects').domain).toBe('projects');
    expect(find('table', 'project_members').domain).toBe('projects');
    expect(find('table', 'comments').domain).toBe('tasks');
    expect(find('table', 'audit_log').domain).toBe('tasks');
  });
});

describe('edges', () => {
  it('follows a handler into its service to find what it writes', () => {
    expect(out(find('command', 'createTask').id, 'writes')).toEqual(['audit_log', 'tasks']);
    expect(out(find('command', 'moveTask').id, 'writes')).toEqual(['tasks']);
  });

  it('sees nested writes and included relations', () => {
    // data: { ...input, members: { create: … } }
    expect(out(find('command', 'createProject').id, 'writes')).toEqual(['audit_log', 'project_members', 'projects']);
    // include: { members: { include: { user: true } }, tasks: true }
    expect(into(find('query', 'getProject').id, 'reads')).toEqual(['project_members', 'projects', 'tasks', 'users']);
  });

  it('draws reads into queries only', () => {
    expect(into(find('query', 'listTasks').id, 'reads')).toEqual(['tasks']);
    // addComment looks the task up before mailing; a command shows what it changes.
    expect(into(find('command', 'addComment').id, 'reads')).toEqual([]);
    expect(out(find('command', 'addComment').id, 'writes')).toEqual(['comments']);
  });

  it('finds the external system behind a library client', () => {
    const smtp = find('external', 'SMTP');
    expect(into(smtp.id, 'calls')).toEqual(['addComment']);
    expect(model.edges.find((e) => e.target === smtp.id)?.evidence.file).toBe('src/lib/mailer.ts');
  });

  it('turns a cron job into a worker', () => {
    const worker = find('worker', 'closeStaleTasks');
    expect(worker).toMatchObject({
      domain: 'tasks',
      label: 'close stale tasks',
      trigger: 'schedule',
      schedule: '0 3 * * *',
      description: 'Tasks nobody touched for 90 days are closed.',
    });
    expect(out(worker.id, 'writes')).toEqual(['audit_log', 'tasks']);
  });

  it('gives lineage from a command through its table to the queries that read it', () => {
    const view = buildView(model);
    const start = view.nodeOf.get(find('command', 'moveTask').id)!;
    const { nodes } = lineage(view, start);
    const reached = [...nodes].flatMap((id) => view.byId.get(id)!.members.map((m) => m.label));
    expect(reached).toEqual(expect.arrayContaining(['tasks', 'listTasks', 'searchTasks', 'getTask', 'projectStats']));
    expect(reached).not.toContain('listUsers');
  });
});

describe('parsePrismaSchema', () => {
  it('reads enums, relations and documentation', () => {
    const schema = parsePrismaSchema(`
      enum Kind {
        a
        b
      }
      /// A thing people own.
      model Thing {
        id    Int    @id @default(autoincrement())
        kind  Kind
        tags  String[]
        owner Owner? @relation(fields: [ownerId], references: [id])
        ownerId Int? @map("owner_id")
        @@unique([kind, ownerId], name: "kind_owner")
      }
      model Owner {
        id     Int @id
        things Thing[]
      }
    `);
    expect(schema.enums.get('Kind')).toEqual(['a', 'b']);
    const thing = schema.models.get('Thing')!;
    expect(thing).toMatchObject({ accessor: 'thing', table: 'Thing', documentation: 'A thing people own.', primaryKey: ['id'] });
    expect(thing.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['id:Int', 'kind:Kind', 'tags:String[]', 'owner_id:Int']);
    expect([...thing.relations]).toEqual([['owner', 'Owner']]);
    expect(thing.indexes).toEqual([{ name: 'kind_owner', columns: ['kind', 'owner_id'], unique: true }]);
    expect(schema.models.get('Owner')!.relations.get('things')).toBe('Thing');
  });
});
