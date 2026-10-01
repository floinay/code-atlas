import ts from 'typescript';
import { callName, isFunctionLike, unwrap } from './ast.ts';
import { specOf, type Evaluator, type FnNode, type FnValue, type Scope, type Value } from './evaluate.ts';

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
  /** Calls on opaque platform values, for adapters that model them (versioning storage). */
  opaque: { value: Value; method: string; node: ts.Node }[];
  /** Top-level functions entered, with the arguments of the first call and whether it sits in a loop. */
  entered: Map<FnNode, { fn: FnValue; args: Value[]; loop: boolean }>;
};

export type ExternalRule = { match: RegExp; system: string | ((file: string) => string) };

export type ReachOptions = {
  isTable(value: Value): boolean;
  externals: ExternalRule[];
  /** Do not descend into these functions (used to keep workers apart). */
  stopAt?: (fn: FnNode) => boolean;
  inlinable(file: string): boolean;
};

const READ_VERBS = /^(get|list|find|search|read|fetch|check|resolve|verify|has|is|load|query|count|sign|describe|head|exists|lookup|select|peek|inspect|watch|probe|validate)/i;
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
  entered: new Map(),
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
    const run = new Run(this.ev, { ...this.options, ...(stopAt ? { stopAt } : {}) }, facts);
    run.enterFn(fn, args, false, [], true);
    return facts;
  }
}

class Run {
  private visited = new Set<string>();
  constructor(
    private ev: Evaluator,
    private options: ReachOptions,
    private facts: Facts,
  ) {}

  enterFn(fn: FnValue, args: Value[], loop: boolean, stack: string[], root = false) {
    if (!fn.node.body || stack.length > MAX_DEPTH) return;
    if (!root && this.options.stopAt?.(fn.node)) return;
    const signature = args.map((a) => (a.k === 'str' ? a.v : a.k === 'call' ? `${a.name}@${a.node.pos}` : a.k)).join(',');
    const key = `${fn.node.getSourceFile().fileName}:${fn.node.pos}|${signature}`;
    if (this.visited.has(key)) return;
    this.visited.add(key);
    if (isTopLevel(fn.node) && !this.facts.entered.has(fn.node)) this.facts.entered.set(fn.node, { fn, args, loop });
    const name = fnName(fn.node);
    this.walk(fn.node.body, this.ev.bind(fn, args), loop, name ? [...stack, name] : stack);
  }

  private walk(node: ts.Node, scope: Scope, loop: boolean, stack: string[]) {
    if (ts.isTypeNode(node)) return;
    if (isFunctionLike(node)) {
      if (!runsInline(node)) return;
      const inner = this.ev.enter(node, scope);
      const timer = isTimerCallback(node);
      if (node.body) this.walk(node.body, inner, loop || timer, stack);
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)) loop = loop || isServiceLoop(node);
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
      ts.isCallExpression(call) &&
      call.arguments[0] === node &&
      ['insert', 'update', 'delete'].includes(callName(call));
    const bucket = writes ? this.facts.tableWrites : this.facts.tableReads;
    if (!bucket.has(value)) bucket.set(value, writes ? call : node);
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

    const target = this.safe(() => this.ev.eval(callee, scope));
    if (target?.k === 'fn' && this.options.inlinable(target.scope.file)) {
      const args = node.arguments.map((_, index) => evalArg(index) ?? ({ k: 'unknown' } as Value));
      this.enterFn(target, args, loop || isIntervalCall(node), stack);
      return;
    }
    if ((name === 'invoke' || name === 'call') && node.arguments.length >= 1) {
      const route = evalArg(0);
      if (route?.k === 'call' && route.name === 'defineRoute' && !this.facts.invokes.has(route)) this.facts.invokes.set(route, node);
    }
    if (target) {
      this.external(target, node, stack, false);
      if (target.k === 'member') this.facts.opaque.push({ value: target.of, method: target.name, node });
      // Calling the result of a platform helper, such as eventDispatcher(handlers),
      // runs the functions that were handed to it.
      if (target.k === 'call') this.enterHeld(target, loop, stack, 0);
    }
    // A known function passed to something we cannot see into is assumed to be called.
    node.arguments.forEach((argument, index) => {
      if (!ts.isIdentifier(argument)) return;
      const value = evalArg(index);
      if (value?.k === 'fn' && this.options.inlinable(value.scope.file)) this.enterFn(value, [], loop || isIntervalCall(node), stack);
    });
  }

  /** Enters every function held by a value: arguments of opaque calls and items of arrays. */
  private enterHeld(value: Value, loop: boolean, stack: string[], depth: number) {
    if (depth > 4) return;
    if (value.k === 'fn') {
      if (this.options.inlinable(value.scope.file)) this.enterFn(value, [], loop, stack);
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
    if (target.k === 'ext' && /^(create|new|make|build)/i.test(target.name.split('.').at(-1) ?? '')) return;
    const file = node.getSourceFile().fileName;
    const system = typeof rule.system === 'string' ? rule.system : rule.system(file);
    const method = target.k === 'member' ? target.name : (stack.at(-1) ?? '');
    const verb = httpVerb(node) ?? '';
    const write = verb ? !/^(GET|HEAD)$/i.test(verb) : !READ_VERBS.test(method) && !READ_VERBS.test(stack.at(-1) ?? method);
    const existing = this.facts.externals.get(system);
    if (!existing) this.facts.externals.set(system, { node, write });
    else if (write && !existing.write) existing.write = true;
  }
}

/** `api(path, body, 'PUT')`: an explicit HTTP verb among the arguments. */
function httpVerb(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  for (const argument of node.arguments)
    if (ts.isStringLiteral(argument) && /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(argument.text)) return argument.text;
  return undefined;
}

const isTopLevel = (fn: FnNode) =>
  (ts.isFunctionDeclaration(fn) && ts.isSourceFile(fn.parent)) ||
  ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isSourceFile(fn.parent.parent.parent.parent));

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
