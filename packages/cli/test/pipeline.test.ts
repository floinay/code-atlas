import { DomainsConfig } from '@code-atlas/model';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickAdapter } from '../src/adapters.ts';
import { loadDomainsConfig } from '../src/config.ts';
import { runExtraction } from '../src/pipeline.ts';

const mini = fileURLToPath(new URL('../../extractor-yeda/test/fixtures/mini', import.meta.url));
const run = (config: unknown, options = {}) => {
  const parsed = DomainsConfig.parse(config);
  return runExtraction(mini, pickAdapter(mini).create(mini, parsed), parsed, options).model;
};

describe('adapters', () => {
  it('detects the Yeda DSL', () => {
    expect(pickAdapter(mini).name).toBe('yeda');
  });
  it('says which adapters exist when none fits', () => {
    expect(() => pickAdapter(tmpdir())).toThrow(/No adapter recognises .* Pass --adapter \(available: /);
    expect(() => pickAdapter(mini, 'cobol')).toThrow('Unknown adapter "cobol"');
  });
});

describe('runExtraction', () => {
  it('draws every domain by default', () => {
    expect(run({}).domains.map((d) => d.id)).toEqual(['billing', 'orders', 'pages']);
  });

  it('collapses the domains that are not explored', () => {
    const model = run({}, { explore: ['orders'] });
    expect(model.domains.map((d) => d.id)).toEqual(['orders']);
    const blocks = model.elements.filter((e) => e.kind === 'external' && e.system === 'domain');
    expect(blocks.map((b) => b.name).sort()).toEqual(['Billing', 'Pages']);
    expect(model.elements.some((e) => e.domain === 'billing')).toBe(false);
  });

  it('takes the explored domains from the config, and lets the command line override them', () => {
    expect(run({ explore: ['billing'] }).domains.map((d) => d.id)).toEqual(['billing']);
    expect(run({ explore: ['billing'] }, { explore: ['pages'] }).domains.map((d) => d.id)).toEqual(['pages']);
  });

  it('names the domains it knows when asked for one it does not', () => {
    expect(() => run({}, { explore: ['order'] })).toThrow('Unknown domain: order. Found: billing, orders, pages.');
  });

  it('drops checks that the config marks as intended', () => {
    expect(run({}).checks).toHaveLength(1);
    expect(run({ checks: { ignore: ['orders.refunded'] } }).checks).toEqual([]);
  });
});

describe('loadDomainsConfig', () => {
  const repo = (yaml?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'code-atlas-'));
    if (yaml !== undefined) {
      mkdirSync(join(dir, '.code-atlas'));
      writeFileSync(join(dir, '.code-atlas', 'domains.yaml'), yaml);
    }
    return dir;
  };

  it('is empty without a file', () => {
    expect(loadDomainsConfig(repo())).toEqual({ domains: {} });
  });

  it('reads overrides', () => {
    const config = loadDomainsConfig(
      repo('explore: [orders]\ndomains:\n  orders:\n    name: Shop orders\n  legacy:\n    ignore: true\n'),
    );
    expect(config).toEqual({
      explore: ['orders'],
      domains: { orders: { name: 'Shop orders' }, legacy: { ignore: true } },
    });
  });

  it('points at the field that is wrong', () => {
    expect(() => loadDomainsConfig(repo('domains:\n  orders:\n    nmae: Typo\n'))).toThrow(
      /\.code-atlas\/domains\.yaml is not valid:\n\s+domains\.orders: /,
    );
  });
});

describe('the second adapter', () => {
  const taskboard = fileURLToPath(new URL('../../../examples/express-prisma', import.meta.url));

  it('is picked for an Express + Prisma app and runs through the same pipeline', () => {
    const adapter = pickAdapter(taskboard);
    expect(adapter.name).toBe('express-prisma');
    const config = DomainsConfig.parse({});
    const model = runExtraction(taskboard, adapter.create(taskboard, config), config, { explore: ['tasks'] }).model;
    expect(model.domains.map((d) => d.id)).toEqual(['tasks']);
    // Neighbouring modules collapse into blocks, exactly as Yeda features do.
    const blocks = model.elements.filter((e) => e.kind === 'external' && e.system === 'domain').map((e) => e.name);
    expect(blocks.sort()).toEqual(['Projects', 'Users']);
  });
});
