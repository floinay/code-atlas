import ts from 'typescript';

/** `foo(...)` → `foo`, `a.b.foo(...)` → `foo`, anything else → ``. */
export function callName(node: ts.Node): string {
  if (!ts.isCallExpression(node)) return '';
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/** Strips parentheses, `as`, `satisfies`, `!` and `await`: none of them change what a value is. */
export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isTypeAssertionExpression(current)
    )
      current = current.expression;
    else return current;
  }
}

export const propertyName = (name: ts.PropertyName | ts.BindingName | undefined): string | undefined => {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
};

export const isFunctionLike = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);

/** The expression a one-line function returns: `(x) => expr` or `{ return expr; }`. */
export function returnedExpression(fn: ts.Node): ts.Expression | undefined {
  if (!isFunctionLike(fn) || !fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return unwrap(fn.body);
  const statements = fn.body.statements;
  const last = statements.at(-1);
  if (last && ts.isReturnStatement(last) && last.expression) return unwrap(last.expression);
  return undefined;
}

export function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void | false): void {
  if (visit(node) === false) return;
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function findCalls(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  walk(node, (child) => {
    if (ts.isCallExpression(child) && callName(child) === name) found.push(child);
  });
  return found;
}

/** `organizationsFeature` → `organizations feature`, `entity_tags` → `entity tags`. */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}
export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
