import { buildView, collapseDomains, weight } from '@code-atlas/model';
import { describe, expect, it } from 'vitest';
import { createYedaExtractor } from '../src/index.ts';
import { reader, yedaRoot } from './helpers.ts';

/**
 * Runs against the real Yeda monorepo and is skipped when there is none.
 * The expectations describe features/organizations and features/tags as they
 * are on main; they are the two domains the design prototype was drawn from.
 */
const root = yedaRoot();

describe.skipIf(!root)('Yeda: organizations and tags', () => {
  const full = root ? createYedaExtractor(root).extract() : undefined;
  const model = full ? collapseDomains(full.model, ['organizations', 'tags']) : undefined!;
  const r = model ? reader(model) : undefined!;

  it('extracts the whole repository in under two seconds', () => {
    expect(full!.stats.ms).toBeLessThan(2000);
  });

  it('is close to the prototype: about 71 elements and 112 edges', () => {
    const view = buildView(model);
    const elements = view.nodes.reduce((sum, n) => sum + (n.kind === 'external' ? 0 : weight(n)), 0);
    expect(elements).toBeGreaterThanOrEqual(68);
    expect(elements).toBeLessThanOrEqual(76);
    expect(view.edges.length).toBeGreaterThanOrEqual(104);
    expect(view.edges.length).toBeLessThanOrEqual(124);
  });

  it('finds the organizations write model', () => {
    expect(r.labels('organizations', 'aggregate')).toEqual([
      'Organization', 'OrganizationProvisioning', 'OrganizationReceipt', 'OrganizationRegistry',
      'OrganizationSlug', 'OrganizationSlugMigration', 'OrganizationSync',
    ]);
    expect(r.labels('organizations', 'event')).toEqual([
      'changed', 'provisioning-changed', 'receipt-recorded', 'registry-changed',
      'slug-changed', 'slugs-backfilled', 'sync-changed',
    ]);
    const sync = r.find('aggregate', 'OrganizationSync');
    expect(sync.state).toEqual({ type: 'OrganizationSync | null', refs: ['OrganizationSync'] });
    expect(r.out(sync.id, 'emits')).toEqual(['organizations.sync-changed']);
  });

  it('splits organizations routes into commands and queries', () => {
    expect(r.labels('organizations', 'command')).toEqual([
      'archive', 'create', 'logo.publish', 'logo.remove', 'resume', 'suspend', 'unarchive', 'update',
    ]);
    expect(r.labels('organizations', 'query')).toEqual(
      expect.arrayContaining([
        'check-lifecycle', 'check-provisioning', 'check-slug', 'get', 'list-mine',
        'provisioning.get', 'registered', 'resolve-brand', 'resolve-slug',
      ]),
    );
  });

  it('records what each organizations command appends', () => {
    expect(r.names(r.find('command', 'organizations.create').appends)).toEqual([
      'organizations.provisioning-changed', 'organizations.registry-changed', 'organizations.slug-changed',
    ]);
    expect(r.names(r.find('command', 'organizations.update').appends)).toEqual([
      'organizations.changed', 'organizations.receipt-recorded', 'organizations.slug-changed', 'organizations.sync-changed',
    ]);
    for (const name of ['suspend', 'resume', 'archive', 'unarchive'])
      expect(r.names(r.find('command', `organizations.${name}`).appends)).toEqual([
        'organizations.changed', 'organizations.receipt-recorded', 'organizations.sync-changed',
      ]);
    expect(r.out(r.find('command', 'organizations.create').id, 'decides')).toEqual([
      'OrganizationProvisioning', 'OrganizationRegistry', 'OrganizationSlug',
    ]);
  });

  it('reads route contracts: http helper, input, responses and errors', () => {
    const create = r.find('command', 'organizations.create');
    expect(create.http).toEqual({ method: 'POST', path: '/api/organizations/create' });
    expect(create.input?.fields?.map((f) => f.name)).toEqual(['…', 'requestId']);
    expect(create.responses).toEqual([
      { status: 202, body: { type: 'OrganizationProvisioning', refs: ['OrganizationProvisioning'] } },
    ]);
    expect(create.errors?.statuses).toEqual([403, 404, 409, 503]);
    expect(create.errors?.codes).toContain('slug-taken');
    expect(r.find('query', 'organizations.registered').http).toBeUndefined();
    expect(r.find('command', 'tags.create')).toMatchObject({
      http: { method: 'POST', path: '/api/tags/create' },
      permission: 'tags.manage',
      responses: [{ status: 201, body: { type: 'Tag', refs: ['Tag'] } }],
    });
  });

  it('bundles the four lifecycle commands into one node', () => {
    const view = buildView(model);
    const bundle = view.byId.get(view.nodeOf.get(r.find('command', 'organizations.suspend').id)!)!;
    expect(bundle.members.map((m) => m.label).sort()).toEqual(['archive', 'resume', 'suspend', 'unarchive']);
  });

  it('finds the organizations workers behind the start loop', () => {
    expect(r.labels('organizations', 'worker')).toEqual([
      'adopt organizations', 'backfill organization slugs', 'provision organization', 'synchronize organization',
    ]);
    const backfill = r.find('worker', 'backfillOrganizationSlugs');
    expect(backfill.trigger).toBe('migration');
    expect(r.names(backfill.appends)).toEqual(['organizations.slug-changed', 'organizations.slugs-backfilled']);
    // Adoption calls the backfill, and still only owns its own events.
    expect(r.names(r.find('worker', 'adoptOrganizations').appends)).toEqual([
      'organizations.changed', 'organizations.registry-changed',
    ]);
    expect(r.names(r.find('worker', 'synchronizeOrganization').appends)).toEqual(['organizations.sync-changed']);
  });

  it('links queries to what they read', () => {
    expect(r.into(r.find('query', 'organizations.get').id, 'reads')).toEqual(['Organization', 'OrganizationSync']);
    expect(r.into(r.find('query', 'organizations.resolve-slug').id, 'reads')).toEqual(['Organization', 'OrganizationSlug']);
    expect(r.into(r.find('query', 'organizations.list-mine').id, 'reads')).toEqual(['organizations.read_organizations']);
    expect(r.into(r.find('query', 'tags.get').id, 'reads')).toEqual(['tags.definitions']);
    expect(r.into(r.find('query', 'tags.list').id, 'reads')).toEqual(['tags.assignments', 'tags.definitions']);
  });

  it('reads the organizations projections, their tables and streams', () => {
    const organizations = r.find('projection', 'organizations.organizations');
    expect(organizations.entity).toMatchObject({
      name: 'organization',
      permissions: ['read', 'update'],
      row: { type: 'OrganizationListItem', refs: ['OrganizationListItem'] },
      consumer: 'organizations-projections-organizations-entities-1',
      search: ['id', 'name', 'slug', 'tags'],
    });
    expect(r.into(organizations.id, 'handles')).toEqual(['organizations.changed', 'organizations.sync-changed']);
    expect(r.out(organizations.id, 'writes')).toEqual(['organizations.read_organizations']);
    expect(r.out(organizations.id, 'streams')).toEqual(['sync.organizations']);
    // Activity builds its event list with handlers.flatMap(...) over on()/combine().
    const activity = r.find('projection', 'organizations.activity');
    expect(r.into(activity.id, 'handles')).toEqual(
      expect.arrayContaining(['organizations.changed', 'tags.tag-created', 'tags.entity-tags-detached', 'Roles']),
    );
    expect(r.out(activity.id, 'writes')).toEqual([
      'organizations.activity_role_scopes', 'organizations.activity_tag_targets',
    ]);
    // Actors spreads Activity's events and adds two from Auth.
    const actors = r.find('projection', 'organizations.actors');
    expect(r.into(actors.id, 'handles')).toEqual(expect.arrayContaining(['organizations.changed', 'tags.tag-deleted', 'Auth', 'Roles']));
    expect(r.out(actors.id, 'writes')).toEqual([
      'organizations.activity_actor_organizations', 'organizations.activity_actor_profiles',
    ]);
  });

  it('reads tags end to end', () => {
    expect(r.kinds('tags')).toEqual({ event: 6, aggregate: 1, table: 2, projection: 2, subscription: 2, command: 6, query: 5 });
    const catalog = r.find('aggregate', 'TagCatalog');
    expect(catalog.state).toEqual({ type: 'TagScopeState', refs: ['TagScopeState'] });
    expect(r.out(catalog.id, 'emits')).toHaveLength(6);
    expect(r.names(r.find('command', 'tags.delete').appends)).toEqual(['tags.tag-deleted']);
    const entityTags = r.find('projection', 'tags.entity_tags');
    expect(entityTags.label).toBe('Entity tags');
    expect(r.into(entityTags.id, 'handles')).toEqual([
      'tags.entity-tags-attached', 'tags.entity-tags-detached', 'tags.entity-tags-set', 'tags.tag-deleted',
    ]);
    expect(r.out(entityTags.id, 'writes')).toEqual(['tags.assignments']);
    expect(r.find('subscription', 'sync.tags')).toMatchObject({ path: '/sync/tags', permission: 'tags.read', row: { type: 'Tag' } });
  });

  it('reads Drizzle tables with primary keys and indexes', () => {
    const assignments = r.find('table', 'tags.assignments');
    expect(assignments.columns.map((c) => c.name)).toEqual([
      'owner', 'generation', 'scope_key', 'entity_type', 'entity_id', 'tag_id', 'value',
    ]);
    expect(assignments.primaryKey).toEqual(['owner', 'generation', 'scope_key', 'entity_type', 'entity_id', 'tag_id']);
    expect(assignments.indexes).toEqual([
      { name: 'assignments_tag', columns: ['owner', 'generation', 'scope_key', 'tag_id'], unique: false },
    ]);
    expect(r.labels('organizations', 'table')).toEqual([
      'activity_actor_organizations', 'activity_actor_profiles', 'activity_role_scopes',
      'activity_tag_targets', 'read_organizations',
    ]);
  });

  it('expands named types', () => {
    expect(model.types['Organization']?.fields?.map((f) => f.name)).toEqual([
      '…', 'id', 'logoKey', 'lifecycle', 'creatorId', 'createdAt', 'updatedAt', 'version',
    ]);
    expect(model.types['OrganizationFields']?.fields?.map((f) => f.name)).toEqual(['name', 'slug', 'tags']);
    expect(model.types['TagSummary']?.fields?.map((f) => f.name)).toEqual(['id', 'slug', 'name', 'color']);
    expect(model.types['TagColor']?.alias).toContain("'slate'");
  });

  it('collapses the neighbours and finds ZITADEL', () => {
    const outside = model.elements.filter((e) => e.kind === 'external');
    expect(outside.map((e) => e.name)).toEqual(expect.arrayContaining(['ZITADEL', 'Roles', 'Auth']));
    const zitadel = r.find('external', 'ZITADEL');
    expect(r.into(zitadel.id, 'calls')).toEqual(['adoptOrganizations', 'provisionOrganization', 'synchronizeOrganization']);
    expect(r.into(r.find('query', 'organizations.resolve-brand').id, 'calls')).toContain('Auth');
  });

  it('points every piece of evidence at a real line', () => {
    for (const item of [...model.elements, ...model.edges]) {
      expect(item.evidence.file).toMatch(/^(features|libs)\//);
      expect(item.evidence.line).toBeGreaterThan(0);
    }
  });
});
