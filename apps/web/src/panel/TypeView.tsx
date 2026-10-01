import type { Field, NamedType, TypeExpr } from '@code-atlas/model';
import { Fragment, type ReactNode } from 'react';
import { t } from '../i18n.ts';

export type Types = Record<string, NamedType>;

/** A type string with its named references highlighted. */
function TypeText({ text, refs }: { text: string; refs: string[] }) {
  if (!refs.length) return <Pipes text={text} />;
  const pattern = new RegExp(`\\b(${refs.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 ? <b key={i}>{part}</b> : <Pipes key={i} text={part} />,
      )}
    </>
  );
}
const Pipes = ({ text }: { text: string }) => (
  <>
    {text.split('|').map((part, i) => (
      <Fragment key={i}>
        {i > 0 && <em>|</em>}
        {part}
      </Fragment>
    ))}
  </>
);

function Row({ name, children }: { name: ReactNode; children?: ReactNode }) {
  return (
    <div className="frow">
      <span className="fn">{name}</span>
      <span className="ft">{children}</span>
    </div>
  );
}

function NamedBody({ type, types, depth }: { type: NamedType; types: Types; depth: number }) {
  if (type.fields) return <Fields fields={type.fields} types={types} depth={depth} />;
  return (
    <Row name={<i>=</i>}>
      <TypeText text={type.alias ?? type.name} refs={type.refs} />
    </Row>
  );
}

/** Field rows. A field whose type names a known type expands to show that type. */
export function Fields({ fields, types, depth = 0 }: { fields: Field[]; types: Types; depth?: number }) {
  return (
    <>
      {fields.map((field, index) => {
        const row = (
          <Row
            name={
              field.name === '…' ? (
                <i>…</i>
              ) : (
                <>
                  {field.name}
                  {field.optional && <i>?</i>}
                </>
              )
            }
          >
            <TypeText text={field.type} refs={field.refs} />
            {field.note && <em> · {field.note}</em>}
          </Row>
        );
        const known = field.refs.filter((r) => types[r]);
        if (!known.length || depth > 3) return <Fragment key={index}>{row}</Fragment>;
        return (
          <details className="fx" key={index}>
            <summary>{row}</summary>
            <div className="nest">
              {known.map((ref) => (
                <Fragment key={ref}>
                  {known.length > 1 && <Row name={<i>{ref}</i>} />}
                  <NamedBody type={types[ref]!} types={types} depth={depth + 1} />
                </Fragment>
              ))}
            </div>
          </details>
        );
      })}
    </>
  );
}

/** A type at a use site: inline fields, or a named type opened one level. */
export function TypeBox({ expr, types }: { expr: TypeExpr; types: Types }) {
  if (expr.fields)
    return (
      <div className="tbox">
        {expr.fields.length ? (
          <Fields fields={expr.fields} types={types} />
        ) : (
          <Row name={<i>{t.emptyObject}</i>} />
        )}
      </div>
    );
  const single = /^(\w+)( \| null)?$/.exec(expr.type);
  const named = single ? types[single[1]!] : undefined;
  return (
    <div className="tbox">
      <div className="tname">
        <TypeText text={expr.type} refs={expr.refs} />
      </div>
      {named ? (
        <NamedBody type={named} types={types} depth={0} />
      ) : (
        expr.refs.filter((r) => types[r]).length > 0 && (
          <Fields
            fields={expr.refs
              .filter((r) => types[r])
              .map((r) => ({ name: r, type: r, optional: false, refs: [r] }))}
            types={types}
          />
        )
      )}
    </div>
  );
}
