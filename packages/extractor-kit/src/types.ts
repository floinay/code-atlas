import type { Field, NamedType, TypeExpr } from '@code-atlas/model';
import type ts from 'typescript';
import type { Evaluator, Value } from './evaluate.ts';

/** A Zod schema, read as a type. */
export type Shape = {
  text: string;
  refs: string[];
  /** Present for inline objects. */
  fields?: Field[];
  /** Every property of an object, with spreads resolved. Used by pick, omit and shape access. */
  props?: Map<string, Shape>;
  /** Literal values of an enum or literal, for error codes. */
  values?: string[];
  optional: boolean;
  notes: string[];
  /** Scalars are inlined at use sites; everything else can become a named type. */
  scalar: boolean;
  min?: string;
  max?: string;
};

const scalar = (text: string, note?: string): Shape => ({
  text,
  refs: [],
  optional: false,
  notes: note ? [note] : [],
  scalar: true,
});

const ZOD_SCALARS: Record<string, string> = {
  string: 'string', number: 'number', boolean: 'boolean', bigint: 'bigint', int: 'int', int32: 'int',
  float32: 'number', float64: 'number', date: 'date', any: 'any', unknown: 'unknown', never: 'never',
  null: 'null', undefined: 'undefined', void: 'void', symbol: 'symbol', nan: 'NaN',
  uuid: 'uuid', uuidv4: 'uuidv4', uuidv7: 'uuidv7', guid: 'uuid', email: 'email', url: 'url',
  cuid: 'cuid', cuid2: 'cuid', ulid: 'ulid', nanoid: 'nanoid', base64: 'base64', jwt: 'jwt',
  ipv4: 'ipv4', ipv6: 'ipv6', e164: 'phone', json: 'json', file: 'file', stringbool: 'boolean',
  'iso.datetime': 'datetime', 'iso.date': 'date', 'iso.time': 'time', 'iso.duration': 'duration',
  'coerce.string': 'string', 'coerce.number': 'number', 'coerce.boolean': 'boolean', 'coerce.date': 'date',
  'coerce.bigint': 'bigint',
};
const PASSTHROUGH = new Set([
  'trim', 'toLowerCase', 'toUpperCase', 'normalize', 'describe', 'meta', 'brand', 'readonly', 'strict',
  'strip', 'passthrough', 'loose', 'catch', 'refine', 'superRefine', 'check', 'transform', 'pipe',
  'overwrite', 'register', 'unwrap', 'prefault', 'catchall', 'startsWith', 'endsWith', 'includes',
  'nonempty', 'finite', 'safe', 'clone', 'exactOptional',
]);

const isZod = (spec: string | undefined) => spec === 'zod' || !!spec?.startsWith('zod/');
const wrap = (text: string) => (/[|&]/.test(text) && !/^\{.*\}$/.test(text) ? `(${text})` : text);
const cut = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Converts evaluated Zod schemas into the model's types and collects the named ones. */
export class TypeReader {
  private entries: { token: string; base: string; owner: string; type: NamedType }[] = [];
  private byDeclaration = new Map<ts.Node, string>();
  private cache = new Map<ts.Node, Shape>();
  private busy = new Set<ts.Node>();
  private depth = 0;

  constructor(
    private ev: Evaluator,
    private ownerOf: (file: string) => string,
  ) {}

  expr(value: Value | undefined): TypeExpr | undefined {
    if (!value || value.k === 'unknown') return undefined;
    const shape = this.shape(value);
    return {
      type: shape.text,
      refs: shape.refs,
      ...(shape.fields ? { fields: shape.fields } : {}),
    };
  }

  shape(value: Value): Shape {
    if (this.depth > 40) return scalar('…');
    this.depth++;
    try {
      const origin = value.origin;
      if (!origin) return this.read(value);
      // A top-level schema: read it once, and refer to it by name when it is a real type.
      const declared = this.byDeclaration.get(origin.node);
      if (declared) return this.reference(declared, this.cache.get(origin.node));
      if (this.busy.has(origin.node)) return scalar(typeName(origin.name));
      let inner = this.cache.get(origin.node);
      if (!inner) {
        this.busy.add(origin.node);
        try {
          inner = this.read(value);
        } finally {
          this.busy.delete(origin.node);
        }
        this.cache.set(origin.node, inner);
      }
      if (inner.scalar || !/^[A-Z]/.test(origin.name)) return inner;
      // `export const TagListItem = Tag` is the same type under another name.
      if (inner.refs.length === 1 && inner.text === inner.refs[0] && !inner.fields) return inner;
      const name = this.register(origin, inner);
      return this.reference(name, inner);
    } finally {
      this.depth--;
    }
  }

  private reference(name: string, inner: Shape | undefined): Shape {
    return {
      text: name,
      refs: [name],
      optional: inner?.optional ?? false,
      notes: [],
      scalar: false,
      ...(inner?.props ? { props: inner.props } : {}),
      ...(inner?.values ? { values: inner.values } : {}),
    };
  }

  /**
   * Named types get a placeholder while reading, because two features may
   * both export `AuthorizationScope`. `finalize` picks the real names.
   */
  private register(origin: NonNullable<Value['origin']>, inner: Shape): string {
    const token = `§${this.entries.length}§`;
    this.byDeclaration.set(origin.node, token);
    this.entries.push({
      token,
      base: typeName(origin.name),
      owner: this.ownerOf(origin.file),
      type: {
        name: token,
        ...(inner.fields ? { fields: inner.fields } : { alias: inner.text }),
        refs: inner.refs.filter((r) => r !== token),
        evidence: this.ev.ws.evidence(origin.node),
      },
    });
    return token;
  }

  /**
   * Chooses final names: the plain name when it is unique or when every
   * definition under it is identical, `domain.Name` otherwise. Returns the
   * type table and a function that rewrites placeholders in any JSON text.
   */
  finalize(): { types: Record<string, NamedType>; rename: (json: string) => string } {
    const baseOf = new Map(this.entries.map((e) => [e.token, e.base]));
    const plain = (text: string) => text.replace(/§\d+§/g, (token) => baseOf.get(token) ?? token);
    const groups = new Map<string, typeof this.entries>();
    for (const entry of this.entries) groups.set(entry.base, [...(groups.get(entry.base) ?? []), entry]);
    const names = new Map<string, string>();
    for (const [base, entries] of groups) {
      const bySignature = new Map<string, typeof this.entries>();
      for (const entry of entries) {
        const signature = plain(JSON.stringify([entry.type.fields ?? null, entry.type.alias ?? null]));
        bySignature.set(signature, [...(bySignature.get(signature) ?? []), entry]);
      }
      const taken = new Set<string>();
      for (const variants of bySignature.values()) {
        let name = base;
        if (bySignature.size > 1) {
          name = `${variants[0]!.owner}.${base}`;
          for (let n = 2; taken.has(name); n++) name = `${variants[0]!.owner}.${base}${n}`;
        }
        taken.add(name);
        for (const entry of variants) names.set(entry.token, name);
      }
    }
    const rename = (json: string) => json.replace(/§\d+§/g, (token) => names.get(token) ?? token);
    const types: Record<string, NamedType> = {};
    for (const entry of this.entries) {
      const name = names.get(entry.token)!;
      if (types[name]) continue;
      const type = JSON.parse(rename(JSON.stringify(entry.type))) as NamedType;
      types[name] = { ...type, name, refs: [...new Set(type.refs)].filter((r) => r !== name) };
    }
    return { types: Object.fromEntries(Object.entries(types).sort(([a], [b]) => a.localeCompare(b))), rename };
  }

  private read(value: Value): Shape {
    switch (value.k) {
      case 'call':
        return this.call(value);
      case 'obj':
        return this.object(value);
      case 'member': {
        // `Schema.shape.field` and `Schema.shape`.
        if (value.name === 'shape') return this.shape(value.of);
        if (value.of.k === 'member' && value.of.name === 'shape') {
          const owner = this.shape(value.of.of);
          return owner.props?.get(value.name) ?? scalar('unknown');
        }
        if (value.name === 'schema' || value.name === 'element' || value.name === 'options') return this.shape(value.of);
        return scalar(value.name);
      }
      case 'str':
        return scalar(`'${value.v}'`);
      case 'ext':
        return scalar(typeName(value.name.split('.').at(-1) ?? 'unknown'));
      case 'unknown':
        return scalar(value.node ? cut(value.node.getText(), 40) : 'unknown');
      default:
        return scalar('unknown');
    }
  }

  private object(value: Extract<Value, { k: 'obj' }>): Shape {
    const props = new Map<string, Shape>();
    for (const [name, thunk] of value.props) props.set(name, this.shape(thunk()));
    return objectShape(props);
  }

  private call(value: Extract<Value, { k: 'call' }>): Shape {
    const arg = (index: number) => value.args[index]?.();
    const recv = value.recv;
    if (!recv) {
      // A helper such as SyncEnvelopeSchema(Row, 'key'): name it after the helper.
      const inner = value.args.map((a) => a()).filter((a) => a.k !== 'str' && a.k !== 'num').map((a) => this.shape(a));
      const base = typeName(value.name);
      return {
        text: inner.length ? `${base}<${inner.map((s) => s.text).join(', ')}>` : base,
        refs: inner.flatMap((s) => s.refs),
        optional: false,
        notes: [],
        scalar: false,
      };
    }
    if (recv.k === 'ext' && isZod(recv.spec)) return this.constructor_(recv.name ? `${recv.name}.${value.name}` : value.name, value);

    const base = this.shape(recv);
    const name = value.name;
    if (PASSTHROUGH.has(name)) return base;
    switch (name) {
      case 'optional':
        return { ...base, optional: true };
      case 'nullable':
        return { ...base, text: `${base.text} | null`, fields: undefined, scalar: base.scalar };
      case 'nullish':
        return { ...base, text: `${base.text} | null`, fields: undefined, optional: true };
      case 'default': {
        const node = value.node.arguments?.[0];
        return node ? { ...base, notes: [...base.notes, `default ${cut(node.getText(), 24)}`] } : base;
      }
      case 'removeDefault':
        return { ...base, notes: base.notes.filter((n) => !n.startsWith('default ')) };
      case 'min':
      case 'gte':
      case 'max':
      case 'lte':
      case 'length': {
        const limit = this.ev.str(arg(0)) ?? cut(value.node.arguments?.[0]?.getText() ?? '?', 16);
        if (name === 'length') return range({ ...base, min: limit, max: limit });
        return range(name === 'min' || name === 'gte' ? { ...base, min: limit } : { ...base, max: limit });
      }
      case 'int':
        return { ...base, text: base.text === 'number' ? 'int' : base.text };
      case 'positive':
        return range({ ...base, min: '1' });
      case 'nonnegative':
        return range({ ...base, min: '0' });
      case 'regex':
      case 'email':
      case 'url':
      case 'uuid':
        return base.notes.includes(name) ? base : { ...base, notes: [...base.notes, name] };
      case 'array':
        return arrayOf(base);
      case 'or': {
        const other = arg(0) ? this.shape(arg(0)!) : scalar('unknown');
        return union([base, other]);
      }
      case 'and':
      case 'merge':
      case 'extend':
      case 'safeExtend': {
        const added = arg(0);
        const extra = added ? this.shape(added) : objectShape(new Map());
        const props = new Map([...(base.props ?? []), ...(extra.props ?? [])]);
        // Extending a named type keeps the name visible: `…Organization` plus the new fields.
        const spread: Field[] =
          base.refs.length === 1 && base.text === base.refs[0]
            ? [{ name: '…', type: base.text, optional: false, refs: [base.text] }]
            : (base.fields ?? []);
        const own = [...(extra.props ?? [])].map(([key, s]) => toField(key, s));
        const fields = [...spread.filter((f) => !extra.props?.has(f.name)), ...own];
        return { ...objectShape(props), fields, refs: [...new Set(fields.flatMap((f) => f.refs))] };
      }
      case 'pick':
      case 'omit': {
        const mask = arg(0);
        const keys = new Set(mask?.k === 'obj' ? mask.props.keys() : []);
        const props = new Map(
          [...(base.props ?? [])].filter(([key]) => (name === 'pick' ? keys.has(key) : !keys.has(key))),
        );
        return objectShape(props);
      }
      case 'partial':
        return objectShape(new Map([...(base.props ?? [])].map(([k, s]) => [k, { ...s, optional: true }])));
      case 'required':
        return objectShape(new Map([...(base.props ?? [])].map(([k, s]) => [k, { ...s, optional: false }])));
      case 'keyof':
        return { ...scalar([...(base.props?.keys() ?? [])].map((k) => `'${k}'`).join(' | ') || 'string'), scalar: false };
      default:
        return base;
    }
  }

  private constructor_(name: string, value: Extract<Value, { k: 'call' }>): Shape {
    const arg = (index: number) => value.args[index]?.();
    const simple = ZOD_SCALARS[name];
    if (simple) return scalar(simple);
    switch (name) {
      case 'object':
      case 'strictObject':
      case 'looseObject':
      case 'interface': {
        const fields = arg(0);
        if (!fields) return objectShape(new Map());
        // z.object(Tag.shape) is Tag again.
        if (fields.k === 'member' && fields.name === 'shape') return this.shape(fields.of);
        return this.shape(fields);
      }
      case 'literal': {
        const literal = arg(0);
        const text = literal?.k === 'str' ? `'${literal.v}'` : cut(value.node.arguments?.[0]?.getText() ?? 'unknown', 30);
        return { ...scalar(text), ...(literal?.k === 'str' ? { values: [literal.v] } : {}) };
      }
      case 'enum': {
        const options = arg(0);
        const values =
          options?.k === 'arr'
            ? options.items.map((i) => this.ev.str(i())).filter((v): v is string => v !== undefined)
            : options?.k === 'obj'
              ? [...options.props.keys()]
              : [];
        return {
          text: values.length ? values.map((v) => `'${v}'`).join(' | ') : 'enum',
          refs: [],
          values,
          optional: false,
          notes: [],
          scalar: values.length <= 3,
        };
      }
      case 'array':
      case 'set':
        return arrayOf(arg(0) ? this.shape(arg(0)!) : scalar('unknown'));
      case 'record':
      case 'partialRecord':
      case 'map': {
        const key = arg(0) ? this.shape(arg(0)!) : scalar('string');
        const item = arg(1) ? this.shape(arg(1)!) : key;
        const keyText = arg(1) ? key.text : 'string';
        return {
          text: `Record<${keyText}, ${item.text}>`,
          refs: [...new Set([...(arg(1) ? key.refs : []), ...item.refs])],
          optional: false,
          notes: [],
          scalar: false,
        };
      }
      case 'tuple': {
        const items = arg(0);
        const shapes = items?.k === 'arr' ? items.items.map((i) => this.shape(i())) : [];
        return { text: `[${shapes.map((s) => s.text).join(', ')}]`, refs: shapes.flatMap((s) => s.refs), optional: false, notes: [], scalar: false };
      }
      case 'union':
      case 'xor': {
        const options = arg(0);
        return union(options?.k === 'arr' ? options.items.map((i) => this.shape(i())) : []);
      }
      case 'discriminatedUnion': {
        const options = arg(1);
        return union(options?.k === 'arr' ? options.items.map((i) => this.shape(i())) : [], true);
      }
      case 'intersection': {
        const parts = [arg(0), arg(1)].filter((a): a is Value => !!a).map((a) => this.shape(a));
        return { text: parts.map((p) => wrap(p.text)).join(' & '), refs: parts.flatMap((p) => p.refs), optional: false, notes: [], scalar: false };
      }
      case 'optional':
        return { ...(arg(0) ? this.shape(arg(0)!) : scalar('unknown')), optional: true };
      case 'nullable': {
        const inner = arg(0) ? this.shape(arg(0)!) : scalar('unknown');
        return { ...inner, text: `${inner.text} | null`, fields: undefined };
      }
      case 'lazy': {
        const getter = arg(0);
        return getter?.k === 'fn' ? this.shape(this.ev.apply(getter, [])) : scalar('unknown');
      }
      case 'custom':
      case 'instanceof':
      case 'templateLiteral':
        return scalar(name === 'templateLiteral' ? 'string' : 'custom');
      default:
        return scalar(name.split('.').at(-1) ?? name);
    }
  }
}

/** `OrganizationSchema` reads as `Organization`. */
const typeName = (name: string) => (name.length > 6 && name.endsWith('Schema') ? name.slice(0, -6) : name);

export function toField(name: string, shape: Shape): Field {
  return {
    name,
    type: shape.text,
    optional: shape.optional,
    ...(shape.notes.length ? { note: shape.notes.join(', ') } : {}),
    refs: shape.refs,
  };
}

function objectShape(props: Map<string, Shape>): Shape {
  const fields = [...props].map(([name, shape]) => toField(name, shape));
  return {
    text: fields.length ? `{ ${fields.map((f) => (f.optional ? `${f.name}?` : f.name)).join(', ')} }` : '{}',
    refs: [...new Set(fields.flatMap((f) => f.refs))],
    fields,
    props,
    optional: false,
    notes: [],
    scalar: false,
  };
}

function arrayOf(item: Shape): Shape {
  return { text: `${wrap(item.text)}[]`, refs: item.refs, optional: false, notes: [], scalar: item.scalar };
}

function union(options: Shape[], discriminated = false): Shape {
  const describe = (s: Shape) =>
    discriminated && s.fields
      ? `{ ${s.fields.map((f) => (/^'[^']*'$/.test(f.type) ? `${f.name}: ${f.type}` : f.name)).join(', ')} }`
      : s.text;
  return {
    text: options.map(describe).join(' | ') || 'never',
    refs: [...new Set(options.flatMap((s) => s.refs))],
    values: options.flatMap((s) => s.values ?? []),
    optional: false,
    notes: [],
    scalar: false,
  };
}

/** Folds min and max into one note: `1–200`, `≤ 10`, `≥ 1`. */
function range(shape: Shape): Shape {
  const notes = shape.notes.filter((n) => !/^(≤|≥|\d|=)/.test(n) || n.startsWith('default'));
  const { min, max } = shape;
  const note = min !== undefined && max !== undefined ? (min === max ? `= ${min}` : `${min}–${max}`) : min !== undefined ? `≥ ${min}` : max !== undefined ? `≤ ${max}` : undefined;
  return { ...shape, notes: note ? [note, ...notes] : notes };
}
