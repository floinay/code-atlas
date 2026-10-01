/**
 * Prints what the extractor finds, for eyeballing against the source.
 *   pnpm tsx packages/extractor-yeda/scripts/inspect.ts <repo> [domain,domain] [--edges] [--json]
 */
import { buildView, collapseDomains } from '@code-atlas/model';
import { createYedaExtractor } from '../src/index.ts';

const [root, only, ...flags] = process.argv.slice(2);
if (!root) throw new Error('usage: inspect.ts <repo> [domains] [--edges] [--json]');
const extractor = createYedaExtractor(root);
const started = performance.now();
const { model: full, stats } = extractor.extract();
const ms = Math.round(performance.now() - started);
const model = only && only !== '-' ? collapseDomains(full, only.split(',')) : full;
if (flags.includes('--json')) {
  console.log(JSON.stringify(model, null, 2));
} else {
  const view = buildView(model);
  console.log(`${stats.files} files in ${ms} ms · ${model.elements.length} elements · ${model.edges.length} edges · view ${view.nodes.length} nodes / ${view.edges.length} edges · ${Object.keys(model.types).length} types · ${model.checks.length} checks`);
  for (const domain of model.domains) {
    console.log(`\n# ${domain.name} (${domain.path})${domain.description ? ' — ' + domain.description : ''}`);
    const byKind = new Map<string, string[]>();
    for (const e of model.elements.filter((x) => x.domain === domain.id)) {
      const extra =
        e.kind === 'command' ? ` ⇒ [${e.appends.map((a) => a.split(':').pop()).join(', ')}]` :
        e.kind === 'worker' ? ` (${e.trigger}) ⇒ [${e.appends.map((a) => a.split(':').pop()).join(', ')}]` : '';
      byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.label + extra]);
    }
    for (const [kind, labels] of byKind) console.log(`  ${kind} (${labels.length}): ${labels.join(' | ')}`);
  }
  const externals = model.elements.filter((e) => e.domain === null);
  if (externals.length) console.log(`\n# outside: ${externals.map((e) => e.label).join(', ')}`);
  if (stats.skipped.length) console.log(`\nroutes without a handler: ${stats.skipped.join(', ')}`);
  if (flags.includes('--edges')) {
    const short = (id: string) => id.split(':').slice(1).join(':');
    for (const e of model.edges) console.log(`  ${short(e.source)} —${e.kind}→ ${short(e.target)}${e.count ? ` ×${e.count}` : ''}   ${e.evidence.file.split('/').pop()}:${e.evidence.line}`);
  }
  for (const c of model.checks) console.log(`check: ${c.detail.event} of ${c.detail.aggregate} not handled by ${c.detail.consumers.join(', ')}`);
}
