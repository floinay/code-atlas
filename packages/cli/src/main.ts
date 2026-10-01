import { buildView } from '@code-atlas/model';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pickAdapter } from './adapters.ts';
import { loadDomainsConfig } from './config.ts';
import { runExtraction } from './pipeline.ts';

const HELP = `code-atlas: a live map of a codebase's architecture

Usage
  code-atlas extract <repo> [--out model.json] [--only a,b] [--adapter name]
  code-atlas serve <repo>   [--port 4400]      [--only a,b] [--adapter name] [--open] [--state-dir dir]

Options
  --out      Where to write the model. Default: model.json. Use - for stdout.
  --only     Draw only these domains in full; the rest collapse into blocks.
  --adapter  Force an adapter instead of detecting one.
  --port     Port for the web app and its WebSocket. Default: 4400.
  --open     Open the browser once the server is up.
  --state-dir  Where serve keeps layout.json. Default: <repo>/.code-atlas.
`;

export async function main(argv: string[]): Promise<void> {
  try {
    await run(argv);
  } catch (error) {
    console.error(`code-atlas: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function run(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      only: { type: 'string' },
      adapter: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean' },
      'state-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, repo] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  if (command !== 'extract' && command !== 'serve') throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  if (!repo) throw new Error(`Which repository? Usage: code-atlas ${command} <repo>`);
  const root = resolve(repo);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a directory.`);

  const config = loadDomainsConfig(root);
  const adapter = pickAdapter(root, values.adapter);
  const explore = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const options = explore ? { explore } : {};

  if (command === 'extract') {
    const { model, stats } = runExtraction(root, adapter.create(root, config), config, options);
    const json = JSON.stringify(model, null, 2) + '\n';
    const out = values.out ?? 'model.json';
    if (out === '-') process.stdout.write(json);
    else {
      writeFileSync(resolve(out), json);
      const view = buildView(model);
      console.error(
        `${adapter.name}: ${model.domains.length} domains, ${model.elements.length} elements, ${model.edges.length} edges ` +
          `(${view.nodes.length} nodes, ${view.edges.length} edges on the map) from ${stats.files} files in ${stats.ms} ms → ${out}`,
      );
    }
    return;
  }

  const { serve } = await import('./serve.ts');
  const port = Number(values.port ?? 4400);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number, got "${values.port}".`);
  await serve({
    root,
    adapter,
    config,
    port,
    open: values.open ?? false,
    ...(values['state-dir'] ? { stateDir: resolve(values['state-dir']) } : {}),
    ...options,
  });
}
