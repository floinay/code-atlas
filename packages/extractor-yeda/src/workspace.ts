import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/** A top-level name in a file: where it is declared, or where it is imported from. */
export type Declaration =
  | { kind: 'variable'; file: string; name: string; node: ts.VariableDeclaration }
  | { kind: 'binding'; file: string; name: string; node: ts.BindingElement }
  | { kind: 'function'; file: string; name: string; node: ts.FunctionDeclaration }
  | { kind: 'class'; file: string; name: string; node: ts.ClassDeclaration }
  | { kind: 'namespace'; file: string; name: string; target: string }
  | { kind: 'external'; file: string; name: string; spec: string; imported: string };

type FileInfo = {
  path: string;
  source: ts.SourceFile;
  stamp: string;
  locals: Map<string, Declaration>;
  imports: Map<string, { spec: string; imported: string }>;
  /** `export { a as b } from './x'` and `export * from './x'` (name undefined). */
  reexports: { spec: string; name?: string; as?: string }[];
  /** `export { a as b }` of a local or imported name. */
  aliases: Map<string, string>;
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', 'output', 'coverage', 'migrations', 'test-fixtures']);
const isSource = (name: string) =>
  /\.(ts|mts)$/.test(name) && !/\.(spec|test|stories)\.(ts|mts)$/.test(name) && !name.endsWith('.d.ts');

/**
 * The files of a repository, parsed on demand and without a type checker.
 * Names are resolved by following imports, re-exports and tsconfig paths,
 * which is all the Yeda DSL needs and keeps a full extraction well under a second.
 */
export class Workspace {
  readonly root: string;
  private files = new Map<string, FileInfo | null>();
  private paths: { prefix: string; suffix: string; wildcard: boolean; targets: string[] }[] = [];
  private moduleCache = new Map<string, string | null>();
  /** Bumped on every change, so caches built on top of the workspace can reset. */
  generation = 0;

  constructor(root: string) {
    this.root = resolve(root);
    this.loadPaths();
  }

  private loadPaths() {
    for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
      const file = join(this.root, name);
      if (!existsSync(file)) continue;
      const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
      const paths = (parsed.config?.compilerOptions?.paths ?? {}) as Record<string, string[]>;
      const baseUrl = resolve(this.root, parsed.config?.compilerOptions?.baseUrl ?? '.');
      for (const [pattern, targets] of Object.entries(paths)) {
        const star = pattern.indexOf('*');
        this.paths.push({
          prefix: star < 0 ? pattern : pattern.slice(0, star),
          suffix: star < 0 ? '' : pattern.slice(star + 1),
          wildcard: star >= 0,
          targets: targets.map((t) => resolve(baseUrl, t)),
        });
      }
      if (this.paths.length) break;
    }
  }

  rel(file: string): string {
    return relative(this.root, file).split(sep).join('/');
  }
  abs(file: string): string {
    return resolve(this.root, file);
  }
  line(node: ts.Node): number {
    const source = node.getSourceFile();
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  }
  evidence(node: ts.Node): { file: string; line: number } {
    return { file: this.rel(node.getSourceFile().fileName), line: this.line(node) };
  }

  /** Every source file under `dir`, skipping tests, build output and dot-folders. */
  listSources(dir: string, skip: (relPath: string) => boolean = () => false): string[] {
    const out: string[] = [];
    const visit = (current: string) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = join(current, entry.name);
        if (skip(this.rel(full))) continue;
        if (entry.isDirectory()) visit(full);
        else if (isSource(entry.name)) out.push(full);
      }
    };
    visit(this.abs(dir));
    return out.sort();
  }

  /** Forgets a file so the next lookup parses it again. Returns true if it was known. */
  invalidate(file: string): boolean {
    const path = this.abs(file);
    const known = this.files.has(path);
    this.files.delete(path);
    this.moduleCache.clear();
    this.generation++;
    return known;
  }

  file(path: string): FileInfo | undefined {
    const cached = this.files.get(path);
    if (cached !== undefined) return cached ?? undefined;
    let text: string;
    let stamp: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error('not a file');
      stamp = `${stat.mtimeMs}:${stat.size}`;
      text = readFileSync(path, 'utf8');
    } catch {
      this.files.set(path, null);
      return undefined;
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const info: FileInfo = { path, source, stamp, locals: new Map(), imports: new Map(), reexports: [], aliases: new Map() };
    for (const statement of source.statements) this.index(info, statement);
    this.files.set(path, info);
    return info;
  }

  private index(info: FileInfo, statement: ts.Statement) {
    const { path } = info;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) return;
      if (clause.name) info.imports.set(clause.name.text, { spec, imported: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) info.imports.set(bindings.name.text, { spec, imported: '*' });
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          info.imports.set(element.name.text, { spec, imported: (element.propertyName ?? element.name).text });
      return;
    }
    if (ts.isExportDeclaration(statement)) {
      const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const clause = statement.exportClause;
      if (!clause && spec) info.reexports.push({ spec });
      if (clause && ts.isNamedExports(clause))
        for (const element of clause.elements) {
          const local = (element.propertyName ?? element.name).text;
          if (spec) info.reexports.push({ spec, name: local, as: element.name.text });
          else if (local !== element.name.text) info.aliases.set(element.name.text, local);
        }
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          info.locals.set(declaration.name.text, { kind: 'variable', file: path, name: declaration.name.text, node: declaration });
        else this.indexPattern(info, declaration.name);
      }
      return;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name)
      info.locals.set(statement.name.text, { kind: 'function', file: path, name: statement.name.text, node: statement });
    if (ts.isClassDeclaration(statement) && statement.name)
      info.locals.set(statement.name.text, { kind: 'class', file: path, name: statement.name.text, node: statement });
  }

  private indexPattern(info: FileInfo, pattern: ts.BindingPattern) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name))
        info.locals.set(element.name.text, { kind: 'binding', file: info.path, name: element.name.text, node: element });
      else this.indexPattern(info, element.name);
    }
  }

  /** The file a module specifier points to, or undefined for packages outside the repo. */
  resolveModule(from: string, spec: string): string | undefined {
    const key = spec.startsWith('.') ? `${dirname(from)}|${spec}` : spec;
    const cached = this.moduleCache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    let found: string | undefined;
    const candidates: string[] = [];
    if (spec.startsWith('.')) candidates.push(resolve(dirname(from), spec));
    else
      for (const mapping of this.paths) {
        if (!mapping.wildcard && mapping.prefix === spec) candidates.push(...mapping.targets);
        else if (mapping.wildcard && spec.startsWith(mapping.prefix) && spec.endsWith(mapping.suffix)) {
          const middle = spec.slice(mapping.prefix.length, spec.length - mapping.suffix.length);
          candidates.push(...mapping.targets.map((t) => t.replace('*', middle)));
        }
      }
    for (const candidate of candidates) {
      for (const attempt of [candidate, `${candidate}.ts`, `${candidate}.mts`, join(candidate, 'index.ts')]) {
        try {
          if (/\.(ts|mts)$/.test(attempt) && statSync(attempt).isFile()) {
            found = attempt;
            break;
          }
        } catch {
          // Try the next spelling.
        }
      }
      if (found) break;
    }
    this.moduleCache.set(key, found ?? null);
    return found;
  }

  /** What `name` means inside `file`: a local declaration or the thing it imports. */
  resolveName(file: string, name: string): Declaration | undefined {
    const info = this.file(file);
    if (!info) return undefined;
    const local = info.locals.get(name);
    if (local) return local;
    const imported = info.imports.get(name);
    if (!imported) return undefined;
    const target = this.resolveModule(file, imported.spec);
    if (!target) return { kind: 'external', file, name, spec: imported.spec, imported: imported.imported };
    if (imported.imported === '*') return { kind: 'namespace', file, name, target };
    return (
      this.resolveExport(target, imported.imported) ??
      ({ kind: 'external', file, name, spec: imported.spec, imported: imported.imported } as const)
    );
  }

  /** The declaration behind an exported name, following re-exports. */
  resolveExport(file: string, name: string, seen = new Set<string>()): Declaration | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const info = this.file(file);
    if (!info) return undefined;
    const alias = info.aliases.get(name);
    if (alias) return this.resolveName(file, alias);
    const local = info.locals.get(name);
    if (local) return local;
    for (const entry of info.reexports) {
      if (entry.name !== undefined && entry.as !== name) continue;
      const target = this.resolveModule(file, entry.spec);
      if (!target) continue;
      const found = this.resolveExport(target, entry.name ?? name, seen);
      if (found) return found;
    }
    // `import { x } from './a'; export { x }` without renaming.
    if (info.imports.has(name)) return this.resolveName(file, name);
    return undefined;
  }

  importSpec(file: string, name: string): string | undefined {
    return this.file(file)?.imports.get(name)?.spec;
  }
}
