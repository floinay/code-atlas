import { sql } from 'drizzle-orm';
import { outbox } from './mail.schema';

export type StartLetterWorkflow = (input: { letterId: string }) => Promise<void>;

export function createRelay(options: { database: () => any; startWorkflow: StartLetterWorkflow }) {
  return {
    runOnce: async () => {
      const database = options.database();
      const claimed = await database.execute(sql`update ${outbox} set status = 'starting' returning id`);
      for (const row of claimed.rows) await options.startWorkflow({ letterId: row.id });
    },
  };
}

/** Polls the outbox: a letter that was accepted is started, however late. */
export function startRelayLoop(options: { relay: ReturnType<typeof createRelay>; intervalMs?: number }) {
  const timer = setInterval(() => {
    void options.relay.runOnce();
  }, options.intervalMs ?? 2000);
  return { close: () => clearInterval(timer) };
}
