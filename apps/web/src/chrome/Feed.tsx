import type { FeedEntry } from '@code-atlas/model';
import { feedText, t } from '../i18n.ts';

type Props = { entries: FeedEntry[]; hasNew: boolean; onClearNew(): void };

const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 8);

/** The latest file changes and what they did to the map. Newest first. */
export function Feed({ entries, hasNew, onClearNew }: Props) {
  return (
    <div className="feed" aria-live="polite">
      <h4>
        {t.feed}
        {hasNew && <button onClick={onClearNew}>{t.clearNew}</button>}
      </h4>
      <ol>
        {entries.map((entry, i) => (
          <li key={`${entry.at}-${entries.length - i}`} className={entry.kind === 'warn' ? 'warn' : undefined}>
            <time>{clock(entry.at)}</time>
            <div>
              <span>{feedText(entry)}</span>
              {entry.file && <code>{entry.file}</code>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
