#!/usr/bin/env node
// The CLI is written in TypeScript and run from source; tsx compiles it on the fly.
import process from 'node:process';
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
await main(process.argv.slice(2));
