import type { Edge, Element, FeedEntry, Model } from '@code-atlas/model';

/**
 * The demo replays what an agent's change looks like on the map, using the
 * bundled fixture: a new event, the command that appends it, the projections
 * that pick it up, and the consumer that was forgotten.
 */
export type DemoStep = { model: Model; feed: FeedEntry; select?: string };

const contracts = 'features/tags/contracts/src/lib/tags-contracts.ts';
const eventId = 'tags:event:tags.tags-merged';
const commandId = 'tags:command:tags.merge';

const note = (text: string, file?: string, kind: FeedEntry['kind'] = 'add'): FeedEntry => ({
  at: new Date().toISOString(),
  kind,
  subject: { type: 'note', text },
  ...(file ? { file } : {}),
});

export const demoIntro = (): FeedEntry => note('Агент почав задачу', '«Додай злиття тегів»', 'info');
export const demoReset = (): FeedEntry => note('Код повернуто до main', 'git checkout main', 'info');
export const demoWarning = (): FeedEntry =>
  note(
    'Auth слухає всі події TagCatalog, крім tags-merged',
    'features/auth/src/lib/user-activity.projection.ts',
    'warn',
  );

export function demoSteps(base: Model): DemoStep[] {
  const find = (name: string) => base.elements.find((e) => e.name === name)!.id;
  const tagError = base.elements.find((e) => e.id === 'tags:command:tags.create');
  const errors = tagError?.kind === 'command' ? tagError.errors : undefined;
  const event: Element = {
    id: eventId,
    kind: 'event',
    domain: 'tags',
    name: 'tags.tags-merged',
    label: 'tags-merged',
    evidence: { file: contracts, line: 570 },
    schemaVersion: 1,
    payload: {
      type: '{ scope, sourceTagIds, targetTagId }',
      refs: ['AuthorizationScope'],
      fields: [
        { name: 'scope', type: 'AuthorizationScope', optional: false, refs: ['AuthorizationScope'] },
        { name: 'sourceTagIds', type: 'uuidv7[]', optional: false, refs: [] },
        { name: 'targetTagId', type: 'uuidv7', optional: false, refs: [] },
      ],
    },
  };
  const command: Element = {
    id: commandId,
    kind: 'command',
    domain: 'tags',
    name: 'tags.merge',
    label: 'merge',
    description: 'Зливає кілька тегів в один і переносить їхні прив’язки.',
    evidence: { file: 'features/tags/src/lib/merge-tags.ts', line: 12 },
    http: { method: 'POST', path: '/api/tags/merge' },
    permission: 'tags.manage',
    input: {
      type: '{ scope, sourceTagIds, targetTagId, requestId }',
      refs: ['AuthorizationScope'],
      fields: [
        { name: 'scope', type: 'AuthorizationScope', optional: false, refs: ['AuthorizationScope'] },
        { name: 'sourceTagIds', type: 'uuidv7[]', optional: false, note: '1–10', refs: [] },
        { name: 'targetTagId', type: 'uuidv7', optional: false, refs: [] },
        { name: 'requestId', type: 'uuidv7', optional: false, refs: [] },
      ],
    },
    responses: [
      {
        status: 200,
        body: {
          type: '{ tag, movedCount }',
          refs: ['Tag'],
          fields: [
            { name: 'tag', type: 'Tag', optional: false, refs: ['Tag'] },
            { name: 'movedCount', type: 'int ≥ 0', optional: false, refs: [] },
          ],
        },
      },
    ],
    ...(errors ? { errors } : {}),
    appends: [eventId],
  };
  const edge = (source: string, target: string, kind: Edge['kind'], file: string): Edge => ({
    source,
    target,
    kind,
    evidence: { file, line: 1 },
  });
  const catalog = find('TagCatalog');
  const entities = 'features/tags/src/lib/tag.entities.ts';
  const activity = 'features/organizations/src/lib/organization-activity.ts';

  const steps: DemoStep[] = [];
  let model = base;
  const push = (elements: Element[], edges: Edge[], feed: FeedEntry, select?: string) => {
    model = { ...model, elements: [...model.elements, ...elements], edges: [...model.edges, ...edges] };
    steps.push({ model, feed, ...(select ? { select } : {}) });
  };
  push([event], [edge(catalog, eventId, 'emits', contracts)], note('+ подія tags-merged', contracts));
  push(
    [command],
    [edge(commandId, catalog, 'decides', 'features/tags/src/lib/merge-tags.ts')],
    note('+ команда tags.merge → TagCatalog', 'features/tags/src/lib/merge-tags.ts'),
  );
  push(
    [],
    [edge(eventId, find('tags.tags'), 'handles', entities), edge(eventId, find('tags.entity_tags'), 'handles', entities)],
    note('Tags і Entity tags слухають tags-merged', entities),
  );
  push(
    [],
    [
      edge(eventId, find('organizations.activity'), 'handles', activity),
      edge(eventId, find('organizations.actors'), 'handles', 'features/organizations/src/lib/organization-actors.ts'),
    ],
    note('Activity і Actors слухають tags-merged', activity),
    commandId,
  );
  return steps;
}
