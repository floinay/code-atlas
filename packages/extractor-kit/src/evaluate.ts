import ts from 'typescript';
import { isFunctionLike, propertyName, returnedExpression, unwrap } from './ast.ts';
import type { Declaration, Workspace } from './workspace.ts';

/**
 * A small symbolic evaluator. It does not run code. It follows names through
 * imports, inlines functions written in feature folders and substitutes their
 * arguments, so `settingsRoutes('settings.user', …)` yields routes named
 * `settings.user.get`, and `runtime.upstream.get(id)` is known to be a call
 * into the ZITADEL client. Anything it cannot follow becomes `unknown`.
 */
export type Thunk = () => Value;
export type Origin = { name: string; file: string; node: ts.Node };
type Meta = { origin?: Origin };

export type ObjValue = Meta & { k: 'obj'; props: Map<string, Thunk>; node: ts.Node; scope: Scope };
export type ArrValue = Meta & { k: 'arr'; items: Thunk[]; node: ts.Node };
export type FnValue = Meta & { k: 'fn'; node: FnNode; scope: Scope };
/** A call the evaluator does not look inside: a DSL definition or a library call. */
export type CallValue = Meta & {
  k: 'call';
  name: string;
  /** The value the method was called on, for `a.b()`. */
  recv?: Value;
  args: Thunk[];
  node: ts.CallExpression | ts.NewExpression;
  scope: Scope;
  /** The package the callee was imported from. */
  spec?: string;
};
/** Something imported from outside the feature folders: a platform function or a package. */
export type ExtValue = Meta & { k: 'ext'; spec: string; name: string };
export type MemberValue = Meta & { k: 'member'; of: Value; name: string; spec?: string };
export type Value =
  | (Meta & { k: 'str'; v: string })
  | (Meta & { k: 'num'; v: number })
  | (Meta & { k: 'bool'; v: boolean })
  | (Meta & { k: 'null' })
  | ObjValue
  | ArrValue
  | FnValue
  | CallValue
  | ExtValue
  | MemberValue
  | (Meta & { k: 'ns'; file: string })
  | (Meta & { k: 'unknown'; node?: ts.Node; scope?: Scope });

export type FnNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

export type Scope = {
  file: string;
  /** Parameters and other names with a known value. */
  values: Map<string, Value>;
  /** The function whose local declarations are visible here. */
  fn?: FnNode;
  parent?: Scope;
  locals?: Map<string, Local>;
  cache?: Map<string, Value>;
};
type Local =
  | { kind: 'variable'; node: ts.VariableDeclaration }
  | { kind: 'binding'; node: ts.BindingElement }
  | { kind: 'function'; node: ts.FunctionDeclaration };

const UNKNOWN: Value = { k: 'unknown' };
/** `fetch` and `globalThis.fetch`. Adapters match it with the rule `/^fetch$/`. */
const FETCH: Value = { k: 'ext', spec: 'fetch', name: 'fetch' };
const MAX_DEPTH = 80;
const memo = (compute: () => Value): Thunk => {
  let value: Value | undefined;
  let busy = false;
  return () => {
    if (value) return value;
    if (busy) return UNKNOWN;
    busy = true;
    try {
      value = compute();
    } finally {
      busy = false;
    }
    return value;
  };
};
export const known = (value: Value): Thunk => () => value;

export class Evaluator {
  private fileScopes = new Map<string, Scope>();
  private declValues = new Map<ts.Node, Value>();
  private busy = new Set<ts.Node>();
  private depth = 0;
  /**
   * Functions outside the feature folders are opaque calls, except the few
   * platform helpers named in `inlinePlatform`, which are simple enough to
   * read through (they build tables or lists from their arguments).
   */
  constructor(
    readonly ws: Workspace,
    private inlinable: (file: string) => boolean,
    private inlinePlatform: Set<string> = new Set(),
    /** The files being read, for finding where a function is called. */
    private sources: () => string[] = () => [],
  ) {}

  /** Whether calls to this function are followed. */
  canInline(fn: FnValue): boolean {
    if (this.inlinable(fn.scope.file)) return true;
    for (let node: ts.Node | undefined = fn.node; node; node = node.parent)
      if (ts.isFunctionDeclaration(node) && node.name && this.inlinePlatform.has(node.name.text)) return true;
    return false;
  }

  fileScope(file: string): Scope {
    let scope = this.fileScopes.get(file);
    if (!scope) {
      scope = { file, values: new Map() };
      this.fileScopes.set(file, scope);
    }
    return scope;
  }

  /** The scope inside `fn`, for looking at its body without calling it. */
  enter(fn: FnNode, parent: Scope, values = new Map<string, Value>()): Scope {
    return { file: parent.file, values, fn, parent };
  }

  /** The lexical scope of an arbitrary node, with every enclosing parameter unknown. */
  scopeAt(node: ts.Node): Scope {
    const chain: FnNode[] = [];
    for (let current = node.parent; current; current = current.parent)
      if (isFunctionLike(current)) chain.unshift(current);
    let scope = this.fileScope(node.getSourceFile().fileName);
    for (const fn of chain) scope = this.enter(fn, scope);
    return scope;
  }

  eval(node: ts.Expression, scope: Scope): Value {
    if (this.depth > MAX_DEPTH) return { k: 'unknown', node, scope };
    this.depth++;
    try {
      return this.evalInner(unwrap(node), scope);
    } finally {
      this.depth--;
    }
  }

  private evalInner(node: ts.Expression, scope: Scope): Value {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { k: 'str', v: node.text };
    if (ts.isNumericLiteral(node)) return { k: 'num', v: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: 'bool', v: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: 'bool', v: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { k: 'null' };
    if (ts.isIdentifier(node)) return this.lookup(node.text, scope, node);
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = this.eval(span.expression, scope);
        if (part.k !== 'str' && part.k !== 'num') return { k: 'unknown', node, scope };
        text += String(part.v) + span.literal.text;
      }
      return { k: 'str', v: text };
    }
    if (ts.isObjectLiteralExpression(node)) return this.evalObject(node, scope);
    if (ts.isArrayLiteralExpression(node)) {
      const items: Thunk[] = [];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = this.eval(element.expression, scope);
          if (spread.k === 'arr') items.push(...spread.items);
          // A list we cannot expand is kept as one item, so readers can still interpret it.
          else if (spread.k !== 'unknown') items.push(known(spread));
        } else items.push(memo(() => this.eval(element, scope)));
      }
      return { k: 'arr', items, node };
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { k: 'fn', node, scope };
    if (ts.isPropertyAccessExpression(node)) return this.member(this.eval(node.expression, scope), node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const target = this.eval(node.expression, scope);
      const key = this.eval(node.argumentExpression, scope);
      if (key.k === 'str') return this.member(target, key.v);
      if (key.k === 'num' && target.k === 'arr') return target.items[key.v]?.() ?? UNKNOWN;
      return { k: 'unknown', node, scope };
    }
    if (ts.isCallExpression(node)) return this.evalCall(node, scope);
    if (ts.isNewExpression(node)) {
      const callee = this.eval(node.expression, scope);
      return {
        k: 'call',
        name: ts.isIdentifier(node.expression) ? node.expression.text : 'new',
        args: (node.arguments ?? []).map((a) => memo(() => this.eval(a, scope))),
        node,
        scope,
        ...(specOf(callee) ? { spec: specOf(callee)! } : {}),
      };
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken) {
        const left = this.eval(node.left, scope);
        const right = this.eval(node.right, scope);
        if ((left.k === 'str' || left.k === 'num') && (right.k === 'str' || right.k === 'num'))
          return { k: 'str', v: String(left.v) + String(right.v) };
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
        const left = this.eval(node.left, scope);
        return isMissing(left) ? this.eval(node.right, scope) : left;
      }
    }
    if (ts.isConditionalExpression(node)) {
      // The condition is a runtime matter; whichever branch holds a value is what the name can be.
      const whenTrue = this.eval(node.whenTrue, scope);
      if (isMissing(whenTrue)) return this.eval(node.whenFalse, scope);
      // `...(x === undefined ? {} : { send: x.send })`: the empty branch says nothing.
      if (whenTrue.k === 'obj' && whenTrue.props.size === 0) {
        const whenFalse = this.eval(node.whenFalse, scope);
        if (whenFalse.k === 'obj') return whenFalse;
      }
      return whenTrue;
    }
    return { k: 'unknown', node, scope };
  }

  private evalObject(node: ts.ObjectLiteralExpression, scope: Scope): Value {
    const props = new Map<string, Thunk>();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = this.eval(property.expression, scope);
        if (spread.k === 'obj') for (const [key, thunk] of spread.props) props.set(key, thunk);
        continue;
      }
      let name = propertyName(property.name);
      if (name === undefined && property.name && ts.isComputedPropertyName(property.name)) {
        const computed = this.eval(property.name.expression, scope);
        if (computed.k === 'str') name = computed.v;
      }
      if (name === undefined) continue;
      if (ts.isPropertyAssignment(property)) {
        const initializer = property.initializer;
        props.set(name, memo(() => this.eval(initializer, scope)));
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const identifier = property.name;
        props.set(name, memo(() => this.lookup(identifier.text, scope, identifier)));
      } else if (ts.isMethodDeclaration(property)) {
        const fn: Value = { k: 'fn', node: property, scope };
        props.set(name, known(fn));
      }
    }
    return { k: 'obj', props, node, scope };
  }

  private evalCall(node: ts.CallExpression, scope: Scope): Value {
    const callee = node.expression;
    const args = node.arguments.map((argument) =>
      ts.isSpreadElement(argument) ? memo(() => this.eval(argument.expression, scope)) : memo(() => this.eval(argument, scope)),
    );
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';

    if (ts.isPropertyAccessExpression(callee)) {
      // Object.values(x), Object.entries(x): the only globals the DSL leans on.
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
        const target = args[0]?.();
        if (target?.k === 'obj') {
          if (name === 'values') return { k: 'arr', items: [...target.props.values()], node };
          if (name === 'keys') return { k: 'arr', items: [...target.props.keys()].map((v) => known({ k: 'str', v })), node };
        }
        if (name === 'assign' || name === 'freeze') return target ?? UNKNOWN;
        return { k: 'unknown', node, scope };
      }
      const recv = this.eval(callee.expression, scope);
      if (recv.k === 'arr') {
        const mapper = args[0]?.();
        if ((name === 'map' || name === 'flatMap') && mapper?.k === 'fn') {
          const results = recv.items.map((item, index) =>
            memo(() => this.apply(mapper, [item(), { k: 'num', v: index }])),
          );
          if (name === 'map') return { k: 'arr', items: results, node };
          return {
            k: 'arr',
            items: results.flatMap((thunk) => {
              const value = thunk();
              return value.k === 'arr' ? value.items : [known(value)];
            }),
            node,
          };
        }
        if (name === 'concat')
          return {
            k: 'arr',
            items: [...recv.items, ...args.flatMap((a) => { const v = a(); return v.k === 'arr' ? v.items : [known(v)]; })],
            node,
          };
        if (name === 'filter' || name === 'slice' || name === 'sort' || name === 'toSorted') return recv;
      }
      // Only plain objects and module namespaces carry callable members of ours;
      // on anything else the name is a library method such as z.string().min().
      const method = recv.k === 'obj' || recv.k === 'ns' ? this.member(recv, name) : undefined;
      if (method?.k === 'fn' && this.canInline(method)) return this.apply(method, args.map((a) => a()));
      const spec = specOf(recv);
      return { k: 'call', name, recv, args, node, scope, ...(spec ? { spec } : {}) };
    }

    const target = this.eval(callee, scope);
    if (target.k === 'fn' && this.canInline(target)) {
      // Spread arguments: `fn(...list)` passes the items of a known array.
      const values = node.arguments.flatMap((argument, index) => {
        const value = args[index]!();
        return ts.isSpreadElement(argument) && value.k === 'arr' ? value.items.map((item) => item()) : [value];
      });
      return this.apply(target, values);
    }
    const spec = specOf(target);
    return { k: 'call', name, args, node, scope, ...(spec ? { spec } : {}) };
  }

  /** The value a function returns for these arguments. */
  apply(fn: FnValue, args: Value[]): Value {
    if (this.depth > MAX_DEPTH) return UNKNOWN;
    const returned = returnedExpression(fn.node);
    if (!returned) return { k: 'unknown', node: fn.node, scope: fn.scope };
    return this.eval(returned, this.bind(fn, args));
  }

  /** The scope inside `fn` when called with `args`. */
  bind(fn: FnValue, args: Value[]): Scope {
    const values = new Map<string, Value>();
    const scope = this.enter(fn.node, fn.scope, values);
    fn.node.parameters.forEach((parameter, index) => {
      let arg: Value = parameter.dotDotDotToken
        ? { k: 'arr', items: args.slice(index).map(known), node: parameter }
        : (args[index] ?? UNKNOWN);
      // `({ makeClient = createClient } = {})`: a missing argument takes its default.
      if (parameter.initializer && isMissing(arg)) arg = this.eval(parameter.initializer, scope);
      if (parameter.type) arg = this.typed(arg, parameter.type, fn.scope);
      this.bindPattern(parameter.name, arg, values, scope);
    });
    return scope;
  }

  /**
   * What the declared type adds to a value nothing else is known about. A
   * parameter typed with a class of an outside package (`client: Client` from
   * `@temporalio/client`) is an instance of it wherever it comes from, so
   * calls on it are calls into that package.
   */
  private typed(value: Value, type: ts.TypeNode, scope: Scope, depth = 0): Value {
    const node = this.typeBody(type, scope.file, 0);
    if (!node) return value;
    if (ts.isTypeReferenceNode(node)) {
      if (!isMissing(value) || !ts.isIdentifier(node.typeName)) return value;
      const declaration = this.ws.resolveName(scope.file, node.typeName.text);
      if (declaration?.kind !== 'external') return value;
      return { k: 'member', of: UNKNOWN, name: node.typeName.text, spec: declaration.spec };
    }
    if (!ts.isTypeLiteralNode(node) || depth > 1) return value;
    if (value.k !== 'obj' && !isMissing(value)) return value;
    let props: Map<string, Thunk> | undefined;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const name = propertyName(member.name);
      const memberType = member.type;
      // Only members that can turn out to be outside instances are worth wrapping.
      if (name === undefined || this.typed(UNKNOWN, memberType, scope, depth + 1) === UNKNOWN) continue;
      const current = value.k === 'obj' ? value.props.get(name) : undefined;
      props ??= new Map(value.k === 'obj' ? value.props : []);
      props.set(name, memo(() => this.typed(current ? current() : UNKNOWN, memberType, scope, depth + 1)));
    }
    if (!props) return value;
    return value.k === 'obj' ? { ...value, props } : { k: 'obj', props, node, scope };
  }

  /** A type with its wrappers removed, following aliases declared in the same file. */
  private typeBody(type: ts.TypeNode, file: string, depth: number): ts.TypeNode | undefined {
    if (depth > 4) return undefined;
    if (ts.isParenthesizedTypeNode(type)) return this.typeBody(type.type, file, depth + 1);
    if (ts.isUnionTypeNode(type)) {
      // `Client | undefined` is a Client that may be absent.
      const present = type.types.filter(
        (t) => t.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
      );
      return present.length === 1 ? this.typeBody(present[0]!, file, depth + 1) : undefined;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      const inner = type.typeArguments?.[0];
      if ((name === 'Readonly' || name === 'Partial' || name === 'Required') && inner) return this.typeBody(inner, file, depth + 1);
      const alias = this.ws
        .file(file)
        ?.source.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
      return alias ? this.typeBody(alias.type, file, depth + 1) : type;
    }
    return type;
  }

  private bindPattern(name: ts.BindingName, value: Value, into: Map<string, Value>, scope: Scope) {
    if (ts.isIdentifier(name)) {
      into.set(name.text, value);
      return;
    }
    name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      const key = ts.isObjectBindingPattern(name)
        ? (propertyName(element.propertyName) ?? propertyName(element.name))
        : undefined;
      let part =
        key !== undefined
          ? this.member(value, key)
          : value.k === 'arr'
            ? (value.items[index]?.() ?? UNKNOWN)
            : UNKNOWN;
      if (element.initializer && isMissing(part)) part = this.eval(element.initializer, scope);
      this.bindPattern(element.name, part, into, scope);
    });
  }

  /** What `name` refers to, walking out through enclosing functions to the file. */
  lookup(name: string, scope: Scope, at?: ts.Node): Value {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const bound = current.values.get(name);
      if (bound) return bound;
      if (!current.fn) continue;
      const cached = current.cache?.get(name);
      if (cached) return cached;
      const local = this.locals(current).get(name);
      if (!local) continue;
      const owner = current;
      const value = this.guard(local.node, () => this.evalLocal(local, owner));
      (owner.cache ??= new Map()).set(name, value);
      return value;
    }
    const declaration = this.ws.resolveName(scope.file, name);
    if (declaration) return this.declared(declaration);
    // The one global that talks to the outside world.
    if (name === 'fetch') return FETCH;
    if (name === 'globalThis') return { k: 'ext', spec: 'globalThis', name: '' };
    return { k: 'unknown', ...(at ? { node: at } : {}), scope };
  }

  private guard(node: ts.Node, compute: () => Value): Value {
    if (this.busy.has(node)) return UNKNOWN;
    this.busy.add(node);
    try {
      return compute();
    } finally {
      this.busy.delete(node);
    }
  }

  private evalLocal(local: Local, scope: Scope): Value {
    if (local.kind === 'function') return { k: 'fn', node: local.node, scope };
    if (local.kind === 'binding') return this.evalBinding(local.node, scope);
    const declaration = local.node;
    const initializer = declaration.initializer;
    // `let x;` or `let x = null;` assigned later, usually inside a start hook: the assignment is the value.
    const placeholder = !initializer || isResetValue(unwrap(initializer));
    const mutable = (declaration.parent.flags & ts.NodeFlags.Let) !== 0;
    const assignment =
      placeholder && mutable && scope.fn ? findAssignment(scope.fn, (declaration.name as ts.Identifier).text) : undefined;
    if (assignment) return this.eval(assignment.right, this.scopeWithin(assignment, scope));
    return initializer ? this.eval(initializer, scope) : UNKNOWN;
  }

  /** The scope of `node`, nested inside the already-bound `outer` scope. */
  private scopeWithin(node: ts.Node, outer: Scope): Scope {
    const chain: FnNode[] = [];
    for (let current = node.parent; current && current !== outer.fn; current = current.parent)
      if (isFunctionLike(current)) chain.unshift(current);
    let scope = outer;
    for (const fn of chain) scope = this.enter(fn, scope);
    return scope;
  }

  private evalBinding(element: ts.BindingElement, scope: Scope): Value {
    const path: (string | number)[] = [];
    let current: ts.Node = element;
    while (ts.isBindingElement(current)) {
      const pattern: ts.BindingPattern = current.parent;
      path.unshift(
        ts.isObjectBindingPattern(pattern)
          ? (propertyName(current.propertyName) ?? propertyName(current.name) ?? '')
          : pattern.elements.indexOf(current),
      );
      current = pattern.parent;
    }
    if (!ts.isVariableDeclaration(current) || !current.initializer) return UNKNOWN;
    let value = this.eval(current.initializer, scope);
    for (const key of path)
      value = typeof key === 'string' ? this.member(value, key) : value.k === 'arr' ? (value.items[key]?.() ?? UNKNOWN) : UNKNOWN;
    return value;
  }

  private locals(scope: Scope): Map<string, Local> {
    if (scope.locals) return scope.locals;
    const locals = new Map<string, Local>();
    const fn = scope.fn!;
    const addPattern = (pattern: ts.BindingPattern) => {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isIdentifier(element.name)) locals.set(element.name.text, { kind: 'binding', node: element });
        else addPattern(element.name);
      }
    };
    const visit = (node: ts.Node) => {
      if (node !== fn && isFunctionLike(node)) {
        if (ts.isFunctionDeclaration(node) && node.name) locals.set(node.name.text, { kind: 'function', node });
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) locals.set(node.name.text, { kind: 'variable', node });
        else addPattern(node.name);
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    scope.locals = locals;
    return locals;
  }

  /** The value of a top-level declaration. */
  declared(declaration: Declaration): Value {
    switch (declaration.kind) {
      case 'external':
        return { k: 'ext', spec: declaration.spec, name: declaration.imported === '*' ? '' : declaration.imported };
      case 'namespace':
        return { k: 'ns', file: declaration.target };
      case 'class':
        return { k: 'unknown', node: declaration.node };
    }
    const node = declaration.node;
    const cached = this.declValues.get(node);
    if (cached) return cached;
    const scope = this.fileScope(declaration.file);
    const origin: Origin = { name: declaration.name, file: declaration.file, node };
    const opaque = !this.inlinable(declaration.file) && !this.inlinePlatform.has(declaration.name);
    const value = this.guard(node, () => {
      if (declaration.kind === 'function')
        return opaque ? this.platform(declaration) : ({ k: 'fn', node: declaration.node, scope } satisfies Value);
      if (declaration.kind === 'binding') return this.evalBinding(declaration.node, scope);
      const initializer = declaration.node.initializer;
      const late =
        (!initializer || isResetValue(unwrap(initializer))) && (declaration.node.parent.flags & ts.NodeFlags.Let) !== 0;
      if (late && !opaque) {
        const assigned = this.assignedLater(declaration.node, declaration.name);
        if (assigned) return assigned;
      }
      if (!initializer) return UNKNOWN;
      if (opaque && isFunctionLike(unwrap(initializer))) return this.platform(declaration);
      return this.eval(initializer, scope);
    });
    // `export const TagListItem = Tag` stays Tag: the first name a value was given is its name.
    const tagged = value.k === 'unknown' || value.origin ? value : { ...value, origin };
    if (!this.busy.has(node)) this.declValues.set(node, tagged);
    return tagged;
  }

  /**
   * A module-level `let` that a function fills in later. When the function
   * assigns its own parameter (`export function bindStarter(start) { starter = start }`),
   * the value is what that function is called with.
   */
  private assignedLater(declaration: ts.VariableDeclaration, name: string): Value | undefined {
    const source = declaration.getSourceFile();
    const assignment = findAssignment(source, name);
    if (!assignment) return undefined;
    let setter: ts.Node | undefined = assignment.parent;
    while (setter && !isFunctionLike(setter)) setter = setter.parent;
    const right = unwrap(assignment.right);
    const index =
      setter && isFunctionLike(setter) && ts.isIdentifier(right)
        ? setter.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === right.text)
        : -1;
    if (index < 0 || !setter || !ts.isFunctionDeclaration(setter) || !setter.name)
      return this.eval(assignment.right, this.scopeAt(assignment));
    const setterName = setter.name.text;
    for (const file of this.sources()) {
      const info = this.ws.file(file);
      if (!info || !info.source.text.includes(`${setterName}(`)) continue;
      let found: Value | undefined;
      const visit = (node: ts.Node) => {
        if (found) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === setterName) {
          const target = this.ws.resolveName(file, setterName);
          const argument = node.arguments[index];
          if (target?.kind === 'function' && target.node === setter && argument && !ts.isSpreadElement(argument))
            found = this.eval(argument, this.scopeAt(node));
        }
        ts.forEachChild(node, visit);
      };
      visit(info.source);
      if (found && !isMissing(found)) return found;
    }
    return undefined;
  }

  /** A function declared outside the feature folders: known by name, never inlined. */
  private platform(declaration: Declaration): Value {
    return { k: 'ext', spec: this.ws.rel(declaration.file), name: declaration.name };
  }

  member(value: Value, name: string): Value {
    switch (value.k) {
      case 'obj': {
        const thunk = value.props.get(name);
        return thunk ? thunk() : { k: 'member', of: value, name };
      }
      case 'arr':
        if (name === 'length') return { k: 'num', v: value.items.length };
        return { k: 'member', of: value, name };
      case 'ns': {
        const declaration = this.ws.resolveExport(value.file, name);
        return declaration ? this.declared(declaration) : UNKNOWN;
      }
      case 'ext':
        if (value.spec === 'globalThis' && !value.name && name === 'fetch') return FETCH;
        return { k: 'ext', spec: value.spec, name: value.name ? `${value.name}.${name}` : name };
      case 'call': {
        const config = value.args[0]?.();
        if (config?.k === 'obj' && config.props.has(name)) return config.props.get(name)!();
        return { k: 'member', of: value, name, ...(value.spec ? { spec: value.spec } : {}) };
      }
      case 'member':
        return { k: 'member', of: value, name, ...(value.spec ? { spec: value.spec } : {}) };
      default:
        return { k: 'member', of: value, name };
    }
  }

  str(value: Value | undefined): string | undefined {
    return value?.k === 'str' ? value.v : value?.k === 'num' ? String(value.v) : undefined;
  }
}

/** Nothing is known about the value: an unbound name, or a property nobody set. */
export function isMissing(value: Value): boolean {
  if (value.k === 'unknown' || value.k === 'null') return true;
  return value.k === 'member' && (value.of.k === 'obj' || isMissing(value.of));
}

/** The package or platform file a value ultimately comes from. */
export function specOf(value: Value | undefined): string | undefined {
  if (!value) return undefined;
  if (value.k === 'ext') return value.spec;
  if (value.k === 'call' || value.k === 'member') return value.spec;
  return undefined;
}

function findAssignment(fn: ts.Node, name: string): ts.BinaryExpression | undefined {
  let found: ts.BinaryExpression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      !isResetValue(node.right)
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}
const isResetValue = (node: ts.Expression) =>
  ts.isVoidExpression(node) ||
  (ts.isIdentifier(node) && node.text === 'undefined') ||
  node.kind === ts.SyntaxKind.NullKeyword ||
  node.kind === ts.SyntaxKind.FalseKeyword ||
  node.kind === ts.SyntaxKind.TrueKeyword ||
  ts.isStringLiteral(node);
