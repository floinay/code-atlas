/**
 * Prints what the reachability walk found for one route. For debugging the extractor.
 *   pnpm tsx packages/extractor-yeda/scripts/facts.ts <repo> <route name>
 */
import { YedaExtraction } from '../src/extract.ts';
import { Workspace, type Facts, type Value } from '@code-atlas/extractor-kit';

const [root, ...names] = process.argv.slice(2);
if (!root || !names.length) throw new Error('usage: facts.ts <repo> <route name>...');
const extraction = new YedaExtraction(new Workspace(root));
extraction.run();
const routeFacts = (extraction as unknown as { routeFacts: Map<string, { facts: Facts }> }).routeFacts;
const show = (value: Value): string =>
  value.k === 'call'
    ? `${value.recv ? show(value.recv) + '.' : ''}${value.name}(…)${value.spec ? ` «${value.spec}»` : ''}`
    : value.k === 'member'
      ? `${show(value.of)}.${value.name}`
      : value.k === 'ext'
        ? `ext ${value.spec}#${value.name}`
        : value.k === 'unknown'
          ? `unknown(${value.node?.getText().slice(0, 30) ?? ''})`
          : value.k;
for (const name of names) {
  const entry = routeFacts.get(name);
  if (!entry) {
    console.log(`${name}: no handler found`);
    continue;
  }
  const { facts } = entry;
  console.log(`\n${name}`);
  console.log('  loads     ', [...facts.loads.keys()].map(show));
  console.log('  drafts    ', [...facts.drafts.keys()].map(show));
  console.log('  writes    ', [...facts.tableWrites.keys()].map(show));
  console.log('  reads     ', [...facts.tableReads.keys()].map(show));
  console.log('  invokes   ', [...facts.invokes.keys()].map(show));
  console.log('  externals ', [...facts.externals].map(([system, e]) => `${system}${e.write ? ' (write)' : ''}`));
  console.log('  opaque    ', [...new Set(facts.opaque.map((o) => `${show(o.value)}.${o.method}`))].slice(0, 40));
}
