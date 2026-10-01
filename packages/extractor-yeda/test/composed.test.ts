import { DomainsConfig } from '@code-atlas/model';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createYedaExtractor } from '../src/index.ts';
import { reader } from './helpers.ts';

const root = fileURLToPath(new URL('./fixtures/composed', import.meta.url));
const config = DomainsConfig.parse({
  domains: { mail: { paths: ['apps/backend/src/mail.ts', 'apps/backend/src/main.ts'] } },
});

/**
 * A feature whose dependencies are bound by the service that hosts it. On its
 * own it accepts letters; composed, it starts workflows and sends mail.
 */
describe('a feature on its own', () => {
  const { model } = createYedaExtractor(root).extract();
  const r = reader(model);

  it('accepts and stores, and reaches no outside system', () => {
    // The relay is found either way: the walk does not know which branches a deployment takes.
    expect(r.kinds('mail')).toEqual({ table: 3, worker: 1, command: 2 });
    expect(r.out(r.find('worker', 'startRelayLoop').id, 'calls')).toEqual([]);
    expect(model.elements.filter((e) => e.kind === 'external')).toEqual([]);
    expect(model.edges.filter((e) => e.kind === 'calls')).toEqual([]);
  });

  it('draws the middleware a start hook returns as a command with its path', () => {
    const webhook = r.find('command', 'mail.postbox-webhook');
    expect(webhook.http).toEqual({ method: 'POST', path: '/api/mail/providers/postbox' });
    expect(webhook.description).toMatch(/^Receives deliverability events/);
    expect(webhook.evidence.file).toBe('features/mail/src/lib/postbox-webhook.handler.ts');
    expect(r.out(webhook.id, 'writes')).toEqual(['mail.provider_events']);
  });
});

describe('a feature composed by a service', () => {
  const extractor = createYedaExtractor(root, config);
  const { model, stats } = extractor.extract();
  const r = reader(model);
  const temporal = model.elements.find((e) => e.name === 'Temporal')!;
  const postbox = model.elements.find((e) => e.name === 'Postbox')!;

  it('reads and watches the paths the config adds to the domain', () => {
    expect(stats.files).toBe(createYedaExtractor(root).extract().stats.files + 2);
    expect(extractor.watch).toEqual(['features', 'libs/platform', 'apps/backend/src/mail.ts', 'apps/backend/src/main.ts']);
    expect(model.domains.map((d) => d.id)).toEqual(['mail', 'people']);
  });

  it('follows a dependency bound through a setter to the engine behind it', () => {
    const relay = r.find('worker', 'startRelayLoop');
    expect(relay.trigger).toBe('loop');
    expect(r.out(relay.id, 'writes')).toEqual(['mail.outbox']);
    // starter(input) → bindMailWorkflows(createWorkflowStarter({ client })) → client: Client from @temporalio/client
    expect(r.out(relay.id, 'calls')).toEqual(['Temporal']);
    expect(model.edges.find((e) => e.source === relay.id && e.target === temporal.id)!.evidence.file).toBe(
      'features/mail/src/lib/workflow-starter.ts',
    );
  });

  it('turns the activities registered on the worker into workflow steps', () => {
    const steps = model.elements.filter((e) => e.kind === 'worker' && e.trigger === 'workflow');
    expect(steps.map((e) => e.name).sort()).toEqual(['completeLetter', 'deliverLetter', 'prepareLetter']);
    expect(steps.every((e) => e.domain === 'mail' && e.evidence.file === 'features/mail/src/lib/activities.ts')).toBe(true);
    expect(r.find('worker', 'prepareLetter').description).toBe('Decides who gets the letter and records one delivery to make.');
    expect(r.out(temporal.id, 'calls')).toEqual(['completeLetter', 'deliverLetter', 'prepareLetter']);
    expect(r.out(r.find('worker', 'completeLetter').id, 'writes')).toEqual(['mail.outbox']);
    expect(r.out(r.find('worker', 'prepareLetter').id, 'writes')).toEqual(['mail.deliveries']);
  });

  it('names a provider reached with fetch after its adapter, and reads the verb as a write', () => {
    const deliver = r.find('worker', 'deliverLetter');
    expect(r.out(deliver.id, 'calls')).toEqual(['Postbox']);
    expect(postbox).toMatchObject({ kind: 'external', system: 'system' });
    expect(postbox.evidence.file).toBe('features/mail/src/lib/postbox-email.ts');
  });

  it('sees a route called through a handle on the router', () => {
    expect(r.out(r.find('worker', 'prepareLetter').id, 'calls')).toEqual(['people.contact']);
  });

  it('connects the provider to its webhook', () => {
    expect(r.into(r.find('command', 'mail.postbox-webhook').id, 'calls')).toEqual(['Postbox']);
  });
});
