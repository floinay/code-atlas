import { DomainsConfig, buildView, collapseDomains, weight } from '@code-atlas/model';
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

describe.skipIf(!root)('Yeda: every feature', () => {
  const { model, stats } = root ? createYedaExtractor(root).extract() : undefined!;
  const r = model ? reader(model) : undefined!;

  it('maps the features that have something to show', () => {
    expect(model.domains.map((d) => d.id)).toEqual([
      'auth', 'forms', 'media', 'notifications', 'organizations', 'page-editor', 'roles', 'secrets',
      'settings', 'tags', 'test-orchestration', 'users', 'websites',
    ]);
    expect(model.elements.length).toBeGreaterThan(450);
    expect(model.edges.length).toBeGreaterThan(800);
  });

  it('does a full extract in under two seconds', () => {
    expect(stats.files).toBeGreaterThan(300);
    // The best of three cold runs: the budget is for the extractor, not for a busy machine.
    const runs = [stats.ms, ...[1, 2].map(() => createYedaExtractor(root!).extract().stats.ms)];
    expect(Math.min(...runs)).toBeLessThan(2000);
  });

  it('expands route factories: settings has the same routes for shared and user documents', () => {
    const settings = [...r.labels('settings', 'command'), ...r.labels('settings', 'query')];
    expect(settings).toEqual(expect.arrayContaining(['get', 'set', 'publish', 'user.get', 'user.set', 'user.publish']));
    expect(r.find('command', 'settings.user.set').http).toEqual({ method: 'POST', path: '/api/settings/user/set' });
  });

  it('models the versioning platform in forms', () => {
    expect(r.labels('forms', 'event')).toEqual([
      'archived', 'created', 'deleted', 'draft-restored', 'draft-saved', 'published', 'unarchived', 'unpublished',
    ]);
    expect(r.names(r.find('command', 'forms.save').appends)).toEqual(['forms.draft-saved']);
    expect(r.names(r.find('command', 'forms.archive').appends)).toEqual(['forms.archived']);
    expect(r.labels('forms', 'projection')).toEqual(['Form drafts', 'Form published', 'Form versions']);
    expect(r.labels('forms', 'table')).toEqual(['form_drafts', 'form_published', 'form_submission', 'form_versions']);
    expect(r.into(r.find('query', 'forms.get-draft').id, 'reads')).toEqual(['forms.form_drafts']);
    // Submissions are plain rows next to the versioned document.
    expect(r.out(r.find('command', 'forms.submissions.set-status').id, 'writes')).toEqual(['forms.form_submission']);
  });

  it('works for features without events: command → table → query', () => {
    expect(r.kinds('media')).toMatchObject({ table: 3, worker: 1 });
    expect(r.out(r.find('command', 'media.uploads.begin').id, 'writes')).toEqual(['media.files']);
    expect(r.into(r.find('query', 'media.files.get').id, 'reads')).toEqual(['media.files']);
    expect(r.out(r.find('command', 'secrets.set').id, 'writes')).toEqual(['secrets.secret_changes', 'secrets.secrets']);
  });

  it('finds consumers that are not entities, and workers of every kind', () => {
    const activity = r.find('projection', 'auth.user_activity');
    expect(r.into(activity.id, 'handles')).toEqual(expect.arrayContaining(['tags.tag-created', 'organizations.changed']));
    expect(r.labels('auth', 'worker')).toEqual(['identity sync.step']);
    expect(r.find('worker', 'migrateAuthorization').trigger).toBe('migration');
    expect(r.find('worker', 'runMaintenance').trigger).toBe('loop');
    expect(r.labels('websites', 'worker')).toEqual([
      'migrate website themes', 'process website domain work', 'reconcile runtime apps',
    ]);
  });

  it('names the external systems', () => {
    const outside = model.elements.filter((e) => e.kind === 'external').map((e) => e.name).sort();
    expect(outside).toEqual(['Domain manager', 'OpenBao', 'S3', 'ZITADEL']);
    expect(r.into(r.find('external', 'OpenBao').id, 'calls')).toEqual(expect.arrayContaining(['secrets.set']));
    // Signing an upload URL does not change anything.
    expect(r.find('query', 'organizations.logo.sign-upload')).toBeDefined();
    expect(r.find('query', 'websites.domain.inspect')).toBeDefined();
  });

  it('draws calls between domains', () => {
    expect(r.out(r.find('command', 'auth.agent-login').id, 'calls')).toEqual(
      expect.arrayContaining(['users.ensure-agent-user']),
    );
    expect(r.into(r.find('query', 'organizations.check-lifecycle').id, 'calls').length).toBeGreaterThan(5);
  });

  it('keeps ids unique and edges attached', () => {
    const ids = model.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(ids);
    for (const edge of model.edges) expect(known.has(edge.source) && known.has(edge.target), `${edge.source} → ${edge.target}`).toBe(true);
    for (const element of model.elements)
      if (element.kind === 'command' || element.kind === 'worker')
        for (const event of element.appends) expect(known.has(event), event).toBe(true);
  });
});

/**
 * `features/notifications` gets its recipient reader, its workflow engine and
 * its mail provider from `apps/backend-service`. Adding those two files to the
 * domain is what puts Temporal and Mailtrap on the map.
 */
describe.skipIf(!root)('Yeda: notifications as the backend service composes them', () => {
  const config = DomainsConfig.parse({
    domains: {
      notifications: { paths: ['apps/backend-service/src/notifications.ts', 'apps/backend-service/src/main-runtime.ts'] },
    },
  });
  const plain = root ? createYedaExtractor(root).extract().model : undefined!;
  const model = root ? createYedaExtractor(root, config).extract().model : undefined!;
  const r = model ? reader(model) : undefined!;

  it('draws the provider webhook as a command even without the composition', () => {
    const webhook = reader(plain).find('command', 'notifications.mailtrap-webhook');
    expect(webhook.http).toEqual({ method: 'POST', path: '/api/notifications/providers/mailtrap' });
    expect(plain.elements.some((e) => e.name === 'Temporal' || e.name === 'Mailtrap')).toBe(false);
  });

  it('starts workflows on Temporal from the outbox relay', () => {
    expect(r.out(r.find('worker', 'startNotificationRelayLoop').id, 'calls')).toEqual(['Temporal']);
  });

  it('runs the activities as workflow steps that Temporal calls', () => {
    const steps = model.elements.filter((e) => e.kind === 'worker' && e.trigger === 'workflow').map((e) => e.name).sort();
    expect(steps).toEqual(['completeNotification', 'deliverNotificationChannel', 'prepareNotificationDeliveries']);
    expect(r.out(r.find('external', 'Temporal').id, 'calls')).toEqual(steps);
    expect(r.out(r.find('worker', 'deliverNotificationChannel').id, 'writes')).toEqual([
      'notifications.in_app_notification', 'notifications.notification_delivery', 'notifications.notification_delivery_attempt',
    ]);
  });

  it('sends mail through Mailtrap and hears back on the webhook', () => {
    expect(r.into(r.find('external', 'Mailtrap').id, 'calls')).toEqual(['deliverNotificationChannel']);
    expect(r.into(r.find('command', 'notifications.mailtrap-webhook').id, 'calls')).toEqual(['Mailtrap']);
  });

  it('reaches people and memberships through the contracts of auth and roles', () => {
    expect(r.out(r.find('worker', 'prepareNotificationDeliveries').id, 'calls')).toEqual(['auth.user-contact']);
    expect(r.out(r.find('command', 'notifications.send').id, 'calls')).toEqual(['roles.scope-membership']);
  });

  it('changes nothing outside notifications', () => {
    const outside = (m: typeof model) => m.elements.filter((e) => e.domain !== 'notifications' && e.domain !== null).map((e) => e.id);
    expect(outside(model)).toEqual(outside(plain));
  });
});
