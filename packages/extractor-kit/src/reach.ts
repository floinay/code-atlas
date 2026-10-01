import ts from 'typescript';
import { callName, isFunctionLike, unwrap } from './ast.ts';
import { specOf, type CallValue, type Evaluator, type FnNode, type FnValue, type Scope, type Value } from './evaluate.ts';

/** What a piece of code does, found by walking everything it can reach. */
export type Facts = {
  /** Aggregates loaded with loadAggregate, by the node that loads them. */
  loads: Map<Value, ts.Node>;
  /** Events drafted for appending. */
  drafts: Map<Value, ts.Node>;
  appends: boolean;
  tableReads: Map<Value, ts.Node>;
  tableWrites: Map<Value, ts.Node>;
  /** Routes of this or another feature called in process. */
  invokes: Map<Value, ts.Node>;
  /** External systems, by name. */
  externals: Map<string, { node: ts.Node; write: boolean }>;
  /** Permissions checked in code. */
  permissions: Map<Value, ts.Node>;
  /**
   * Method calls on values the walk cannot look into, for adapters that know
   * what they mean: a versioning storage, a Prisma client, an Express response.
   */
  opaque: { value: Value; method: string; node: ts.CallExpression; scope: Scope }[];
  /** `listenEvents(...)` consumers started here. */
  listeners: CallValue[];
  /** A service loop or interval runs inside. */
  loops: boolean;
  /** Functions called straight from the analysed function: the candidates for workers. */
  entries: Entry[];
  /** Functions the walk was told not to enter. */
  stopped: Entry[];
};
export type Entry = { fn: FnValue; args: Value[]; loop: boolean; node: ts.Node };

export type ExternalRule = {
  /** Matched against the package or platform file a value comes from. */
  match: RegExp;
  system: string | ((file: string) => string);
  /**
   * Whether calling a function imported straight from the package counts.
   * Most packages hand out a client first, and only calls on that client count.
   */
  direct?: boolean;
};

export type ReachOptions = {
  isTable(value: Value): boolean;
  externals: ExternalRule[];
  /** Do not descend into these functions (used to keep workers apart). */
  stopAt?: (fn: FnNode) => boolean;
};

/**
 * A call to an external system counts as a write only with evidence: an HTTP
 * verb other than GET, an SDK command that mutates, or a name that says so.
 */
const WRITE_VERBS =
  /^(create|update|delete|remove|set|add|put|post|patch|send|upload|write|assign|revoke|disable|enable|activate|deactivate|publish|unpublish|reconcile|ensure|register|unregister|provision|apply|grant|bootstrap|import|rotate|reserve|release|bind|unbind|connect|disconnect|start|stop|cancel|complete|abort|copy|move|rename|restore|archive|suspend|resume|invite|notify|mutate|save|store|insert|upsert|purge|destroy|terminate|issue|encrypt|rewrap|seal)/i;
const PLUMBING = /^(bind|call|apply|then|catch|finally|on|once|off|pipe|ref|unref|setTimeout|toString|toJSON)$/;
const SDK_WRITE = /^(Put|Delete|Copy|Create|Complete|Abort|Upload|Restore|Send|Update|Start|Stop)/;
const SDK_READ = /^(Get|Head|List|Describe)/;
const MAX_DEPTH = 14;

export const emptyFacts = (): Facts => ({
  loads: new Map(),
  drafts: new Map(),
  appends: false,
  tableReads: new Map(),
  tableWrites: new Map(),
  invokes: new Map(),
  externals: new Map(),
  permissions: new Map(),
  opaque: [],
  listeners: [],
  loops: false,
  entries: [],
  stopped: [],
});

/**
 * Walks a function and everything it calls inside the feature folders.
 * Closures are only followed when they are called or passed as arguments,
 * so a helper that is defined but unused leaves no trace.
 */
export class Reach {
  constructor(
    private ev: Evaluator,
    private options: ReachOptions,
  ) {}

  analyze(fn: FnValue, args: Value[] = [], stopAt?: (fn: FnNode) => boolean): Facts {
    const facts = emptyFacts();
    const run = new Run(this.ev, { ...this.options, ...(stopAt ? { stopAt } : {}) }, facts, fn.node);
    run.enterFn(fn, args, false, [], true);
    return facts;
  }

  /** Walks the functions held by values, such as the handlers given to `listenEvents`. */
  analyzeHeld(values: Value[], root: ts.Node): Facts {
    const facts = emptyFacts();
    const run = new Run(this.ev, this.options, facts, root);
    for (const value of values) run.enterHeld(value, false, [], 0);
    return facts;
  }
}

class Run {
  private visited = new Set<string>();
  /** True while walking the analysed function itself, false inside anything it calls. */
  private atRoot = true;
  constructor(
    private ev: Evaluator,
    private options: ReachOptions,
    private facts: Facts,
    private rootNode: ts.Node,
  ) {}

  enterFn(fn: FnValue, args: Value[], loop: boolean, stack: string[], root = false, at?: ts.Node) {
    if (!fn.node.body || stack.length > MAX_DEPTH) return;
    // A closure written inside the analysed function is part of it.
    const local = root || isInside(fn.node, this.rootNode);
    if (!local && this.atRoot && at) this.facts.entries.push({ fn, args, loop, node: at });
    if (!root && this.options.stopAt?.(fn.node)) {
      this.facts.stopped.push({ fn, args, loop, node: at ?? fn.node });
      return;
    }
    const signature = args.map((a) => (a.k === 'str' ? a.v : a.k === 'call' ? `${a.name}@${a.node.pos}` : a.k)).join(',');
    const key = `${fn.node.getSourceFile().fileName}:${fn.node.pos}|${signature}`;
    if (this.visited.has(key)) return;
    this.visited.add(key);
    const name = fnName(fn.node);
    const wasRoot = this.atRoot;
    this.atRoot = wasRoot && local;
    try {
      this.walk(fn.node.body, this.ev.bind(fn, args), loop, name ? [...stack, name] : stack);
    } finally {
      this.atRoot = wasRoot;
    }
  }

  private walk(node: ts.Node, scope: Scope, loop: boolean, stack: string[]) {
    if (ts.isTypeNode(node)) return;
    if (isFunctionLike(node)) {
      if (!runsInline(node)) return;
      const inner = this.ev.enter(node, scope);
      const timer = isTimerCallback(node);
      if (timer) this.facts.loops = true;
      if (node.body) this.walk(node.body, inner, loop || timer, stack);
      return;
    }
    if ((ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)) && isServiceLoop(node)) {
      loop = true;
      this.facts.loops = true;
    }
    if (ts.isCallExpression(node)) this.call(node, scope, loop, stack);
    else if (ts.isNewExpression(node)) this.external(this.safe(() => this.ev.eval(node, scope)), node, stack, true);
    else if (ts.isIdentifier(node) && isValueUse(node)) this.identifier(node, scope);
    ts.forEachChild(node, (child) => this.walk(child, scope, loop, stack));
  }

  private safe<T>(compute: () => T): T | undefined {
    try {
      return compute();
    } catch {
      return undefined;
    }
  }

  private identifier(node: ts.Identifier, scope: Scope) {
    const value = this.safe(() => this.ev.lookup(node.text, scope, node));
    if (!value || !this.options.isTable(value)) return;
    const call = node.parent;
    const writes =
      (ts.isCallExpression(call) &&
        call.arguments[0] === node &&
        ['insert', 'update', 'delete'].includes(callName(call))) ||
      isRawSqlWrite(node);
    const bucket = writes ? this.facts.tableWrites : this.facts.tableReads;
    if (!bucket.has(value)) bucket.set(value, ts.isCallExpression(call) ? call : node);
  }

  private call(node: ts.CallExpression, scope: Scope, loop: boolean, stack: string[]) {
    const name = callName(node);
    const callee = node.expression;
    const evalArg = (index: number) => {
      const argument = node.arguments[index];
      return argument && !ts.isSpreadElement(argument) ? this.safe(() => this.ev.eval(argument, scope)) : undefined;
    };

    if (name === 'appendToStream' || name === 'appendToStreams') this.facts.appends = true;
    if (name === 'loadAggregate') {
      const config = evalArg(0);
      const definition = config?.k === 'obj' ? config.props.get('definition')?.() : undefined;
      if (definition && definition.k !== 'unknown' && !this.facts.loads.has(definition)) this.facts.loads.set(definition, node);
    }
    if (name === 'draft' && ts.isPropertyAccessExpression(callee)) {
      const event = this.safe(() => this.ev.eval(callee.expression, scope));
      if (event && event.k !== 'unknown' && !this.facts.drafts.has(event)) this.facts.drafts.set(event, node);
    }
    if ((name === 'can' || name === 'require' || name === 'assert') && ts.isPropertyAccessExpression(callee)) {
      const permission = evalArg(0);
      if (permission?.k === 'call' && permission.name === 'definePermission' && !this.facts.permissions.has(permission))
        this.facts.permissions.set(permission, node);
    }

    if (name === 'listenEvents') {
      const listener = this.safe(() => this.ev.eval(node, scope));
      if (listener?.k === 'call') this.facts.listeners.push(listener);
    }

    const target = this.safe(() => this.ev.eval(callee, scope));
    if (target?.k === 'fn' && this.ev.canInline(target)) {
      const args = node.arguments.map((_, index) => evalArg(index) ?? ({ k: 'unknown' } as Value));
      this.enterFn(target, args, loop || isIntervalCall(node), stack, false, node);
      return;
    }
    // `router.invoke(Route, input)`, and any handle on the router that is called with a route by name:
    // `routes(GetUserContact, { userId })`.
    const first = node.arguments[0];
    const opaqueCallee = !target || target.k === 'unknown' || target.k === 'member';
    if (first && (name === 'invoke' || name === 'call' || (opaqueCallee && ts.isIdentifier(first)))) {
      const route = evalArg(0);
      if (route?.k === 'call' && route.name === 'defineRoute' && !this.facts.invokes.has(route)) this.facts.invokes.set(route, node);
    }
    if (target) {
      this.external(target, node, stack, false);
      if (target.k === 'member') this.facts.opaque.push({ value: target.of, method: target.name, node, scope });
      // Calling the result of a platform helper, such as eventDispatcher(handlers),
      // runs the functions that were handed to it.
      if (target.k === 'call') this.enterHeld(target, loop, stack, 0);
    }
    // A known function passed to something we cannot see into is assumed to be called.
    node.arguments.forEach((argument, index) => {
      if (!ts.isIdentifier(argument)) return;
      const value = evalArg(index);
      if (value?.k === 'fn' && this.ev.canInline(value)) this.enterFn(value, [], loop || isIntervalCall(node), stack, false, node);
    });
  }

  /** Enters every function held by a value: arguments of opaque calls and items of arrays. */
  enterHeld(value: Value, loop: boolean, stack: string[], depth: number) {
    if (depth > 4) return;
    if (value.k === 'fn') {
      if (this.ev.canInline(value)) this.enterFn(value, [], loop, stack);
    } else if (value.k === 'arr') {
      for (const item of value.items) this.enterHeld(item(), loop, stack, depth + 1);
    } else if (value.k === 'call') {
      for (const arg of value.args) this.enterHeld(arg(), loop, stack, depth + 1);
    }
  }

  private external(target: Value | undefined, node: ts.Node, stack: string[], constructing: boolean) {
    const spec = specOf(target);
    if (!target || !spec) return;
    const rule = this.options.externals.find((r) => r.match.test(spec));
    if (!rule) return;
    // Building a client is not talking to the system yet.
    if (constructing) return;
    if (target.k === 'ext' && (!rule.direct || /^(create|new|make|build|load)/i.test(target.name.split('.').at(-1) ?? ''))) return;
    // Function plumbing and stream events are not requests.
    if (target.k === 'member' && PLUMBING.test(target.name)) return;
    const file = node.getSourceFile().fileName;
    const system = typeof rule.system === 'string' ? rule.system : rule.system(file);
    const write = isExternalWrite(target, node, stack, !!rule.direct);
    const existing = this.facts.externals.get(system);
    if (!existing) this.facts.externals.set(system, { node, write });
    else if (write && !existing.write) existing.write = true;
  }
}

/** sql`update ${table} set …`: the table is the target of a raw write. */
function isRawSqlWrite(node: ts.Identifier): boolean {
  const span = node.parent;
  if (!ts.isTemplateSpan(span)) return false;
  const template = span.parent;
  const index = template.templateSpans.indexOf(span);
  const before = index === 0 ? template.head.text : template.templateSpans[index - 1]!.literal.text;
  return /\b(update|insert\s+into|delete\s+from)\s*$/i.test(before);
}

/** `api(path, body, 'PUT')` or `fetch(url, { method: 'PUT' })`: an explicit HTTP verb among the arguments. */
function httpVerb(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const verb = (value: ts.Node) =>
    ts.isStringLiteral(value) && /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(value.text) ? value.text : undefined;
  for (const argument of node.arguments) {
    if (verb(argument)) return verb(argument);
    // fetch(url, { method: 'POST', … })
    if (ts.isObjectLiteralExpression(argument))
      for (const property of argument.properties)
        if (ts.isPropertyAssignment(property) && property.name.getText() === 'method' && verb(property.initializer))
          return verb(property.initializer);
  }
  return undefined;
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

/** The top-level function a nested function was written in. */
export function enclosingFunction(fn: ts.Node): FnNode | undefined {
  let found: FnNode | undefined;
  for (let current = fn.parent; current; current = current.parent) if (isFunctionLike(current)) found = current;
  return found;
}

export function fnName(fn: FnNode): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/** A function literal that runs where it is written: a call argument or an IIFE. */
function runsInline(fn: ts.Node): boolean {
  let child = fn;
  let parent = fn.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isAwaitExpression(parent))) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    return parent.expression === child || (parent.arguments?.some((argument) => argument === child) ?? false);
  // `.then(...)`-style chains and array literals of handlers passed along.
  if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) return true;
  return false;
}

/**
 * Whether a call to an external system changes something there. It needs
 * evidence; a call nothing is known about counts as a read.
 */
function isExternalWrite(target: Value, node: ts.Node, stack: string[], rawTransport: boolean): boolean {
  const called = target.k === 'member' ? target.name : target.k === 'ext' ? (target.name.split('.').at(-1) ?? '') : '';
  // Signing a URL prepares a request; it does not make one.
  if (/sign/i.test(called)) return false;
  const verb = httpVerb(node);
  if (verb) return !/^(GET|HEAD)$/i.test(verb);
  const command = sdkCommand(node);
  if (command) return SDK_WRITE.test(command);
  // api(path, body): a REST helper. A body means POST, unless the path is a search.
  if (target.k === 'call' && ts.isCallExpression(node)) {
    const path = node.arguments[0];
    if (path && (ts.isStringLiteral(path) || ts.isTemplateLiteral(path))) {
      const body = node.arguments[1];
      // POST /v2/users with { queries, sortingColumn } is a list, not a create.
      const isQuery =
        !!body &&
        ts.isObjectLiteralExpression(body) &&
        body.properties.some((p) => /^(query|queries|filter|filters|pagination|sortingColumn)$/.test(p.name?.getText() ?? ''));
      return !/_search|\/search|\/query/.test(path.getText()) && !!body && !isQuery;
    }
  }
  // A raw transport (https.request) is written to for every request, so only its callers' names count.
  const names = rawTransport ? stack.slice(-3) : [called, ...stack.slice(-2)];
  return names.some((name) => WRITE_VERBS.test(name));
}

/** `client.send(new PutObjectCommand(…))`: the command class says what happens. */
function sdkCommand(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  for (const argument of node.arguments)
    if (ts.isNewExpression(argument) && ts.isIdentifier(argument.expression)) {
      const name = argument.expression.text;
      if (SDK_WRITE.test(name) || SDK_READ.test(name)) return name;
    }
  return undefined;
}

const isIntervalCall = (node: ts.CallExpression) => callName(node) === 'setInterval';
const isTimerCallback = (fn: ts.Node) => ts.isCallExpression(fn.parent) && isIntervalCall(fn.parent);

/** `while (!stopped)` is a service loop; `for (const x of list)` is just iteration. */
function isServiceLoop(node: ts.WhileStatement | ts.DoStatement | ts.ForStatement): boolean {
  if (ts.isForStatement(node)) return !node.condition;
  const condition = unwrap(node.expression);
  return condition.kind === ts.SyntaxKind.TrueKeyword || ts.isPrefixUnaryExpression(condition) || ts.isIdentifier(condition);
}

/** An identifier that reads a value, as opposed to naming a property or declaring something. */
function isValueUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) return parent.name !== node;
  if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isLabeledStatement(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isTypeReferenceNode(parent)) return false;
  return true;
}
