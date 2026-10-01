import type { Column, Field, TableIndex } from '@code-atlas/model';

/** A model from `schema.prisma`, as far as the map needs it. */
export type PrismaModel = {
  name: string;
  /** `prisma.projectMember`: the model name with a lower-case first letter. */
  accessor: string;
  /** The table name: `@@map`, or the model name. */
  table: string;
  line: number;
  columns: Column[];
  primaryKey: string[];
  indexes: TableIndex[];
  /** Relation field → the model it points to. */
  relations: Map<string, string>;
  /** Every field, for showing the model as a type. */
  fields: Field[];
  documentation?: string;
};

export type PrismaSchema = { models: Map<string, PrismaModel>; enums: Map<string, string[]> };

const list = (text: string) =>
  text
    .split(',')
    .map((item) => item.trim().replace(/\(.*\)$/, ''))
    .filter(Boolean);

/**
 * Reads models and enums from a Prisma schema. It is a line reader, not a full
 * parser: the schema language puts one field or one attribute on each line.
 */
export function parsePrismaSchema(text: string): PrismaSchema {
  const lines = text.split('\n');
  const blocks: { kind: string; name: string; line: number; body: { text: string; line: number }[]; doc: string[] }[] = [];
  let current: (typeof blocks)[number] | undefined;
  let doc: string[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!current) {
      const open = /^(model|enum|view)\s+(\w+)\s*\{/.exec(line);
      if (open) current = { kind: open[1]!, name: open[2]!, line: index + 1, body: [], doc };
      doc = line.startsWith('///') ? [...doc, line.slice(3).trim()] : [];
      return;
    }
    if (line === '}') {
      blocks.push(current);
      current = undefined;
      return;
    }
    if (line && !line.startsWith('//')) current.body.push({ text: line.replace(/\s+\/\/.*$/, ''), line: index + 1 });
  });

  const enums = new Map(blocks.filter((b) => b.kind === 'enum').map((b) => [b.name, b.body.map((l) => l.text.split(/\s/)[0]!)]));
  const modelNames = new Set(blocks.filter((b) => b.kind !== 'enum').map((b) => b.name));
  const models = new Map<string, PrismaModel>();

  for (const block of blocks) {
    if (block.kind === 'enum') continue;
    const model: PrismaModel = {
      name: block.name,
      accessor: block.name[0]!.toLowerCase() + block.name.slice(1),
      table: block.name,
      line: block.line,
      columns: [],
      primaryKey: [],
      indexes: [],
      relations: new Map(),
      fields: [],
      ...(block.doc.length ? { documentation: block.doc.join(' ') } : {}),
    };
    const columnOf = new Map<string, string>();
    const blockAttributes: string[] = [];
    for (const { text } of block.body) {
      if (text.startsWith('@@')) {
        blockAttributes.push(text);
        continue;
      }
      const match = /^(\w+)\s+([\w.]+)(\[\]|\?)?\s*(.*)$/.exec(text);
      if (!match) continue;
      const [, name, type, modifier, attributes] = match as unknown as [string, string, string, string | undefined, string];
      const optional = modifier === '?';
      const isList = modifier === '[]';
      if (modelNames.has(type)) {
        model.relations.set(name, type);
        model.fields.push({ name, type: isList ? `${type}[]` : type, optional, refs: [type] });
        continue;
      }
      const column = /@map\("([^"]+)"\)/.exec(attributes)?.[1] ?? name;
      columnOf.set(name, column);
      const isId = /(^|\s)@id\b/.test(attributes);
      const defaultValue = /@default\(((?:[^()]|\([^()]*\))*)\)/.exec(attributes)?.[1];
      const notes = [
        defaultValue !== undefined ? `default ${defaultValue}` : '',
        /(^|\s)@updatedAt\b/.test(attributes) ? 'updated automatically' : '',
      ].filter(Boolean);
      model.columns.push({
        name: column,
        type: isList ? `${type}[]` : type,
        primaryKey: isId,
        notNull: !optional,
        ...(notes.length ? { note: notes.join(', ') } : {}),
      });
      if (/(^|\s)@unique\b/.test(attributes)) model.indexes.push({ name: `${column}_key`, columns: [column], unique: true });
      model.fields.push({
        name,
        type: isList ? `${type}[]` : type,
        optional,
        ...(enums.has(type) ? { note: enums.get(type)!.join(' | ') } : {}),
        refs: [],
      });
    }
    const columns = (inner: string) => list(inner).map((field) => columnOf.get(field) ?? field);
    for (const attribute of blockAttributes) {
      const mapped = /^@@map\("([^"]+)"\)/.exec(attribute);
      if (mapped) model.table = mapped[1]!;
      const fields = /^@@(id|unique|index)\(\[([^\]]*)\]/.exec(attribute);
      if (!fields) continue;
      const names = columns(fields[2]!);
      if (fields[1] === 'id') model.primaryKey = names;
      else
        model.indexes.push({
          name: /(?:name|map):\s*"([^"]+)"/.exec(attribute)?.[1] ?? `${names.join('_')}_${fields[1] === 'unique' ? 'key' : 'idx'}`,
          columns: names,
          unique: fields[1] === 'unique',
        });
    }
    if (!model.primaryKey.length) model.primaryKey = model.columns.filter((c) => c.primaryKey).map((c) => c.name);
    for (const column of model.columns) if (model.primaryKey.includes(column.name)) column.primaryKey = true;
    models.set(model.name, model);
  }
  return { models, enums };
}
