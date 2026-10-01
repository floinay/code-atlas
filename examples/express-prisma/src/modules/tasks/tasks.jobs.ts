import cron from 'node-cron';
import { prisma } from '../../db';
import { recordAudit } from '../../lib/audit';

/** Tasks nobody touched for 90 days are closed. */
export async function closeStaleTasks() {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const closed = await prisma.task.updateMany({
    where: { status: { not: 'done' }, updatedAt: { lt: cutoff } },
    data: { status: 'done' },
  });
  if (closed.count) await recordAudit(null, 'tasks.closed-stale', String(closed.count));
}

export function startTaskJobs() {
  cron.schedule('0 3 * * *', () => closeStaleTasks());
}
