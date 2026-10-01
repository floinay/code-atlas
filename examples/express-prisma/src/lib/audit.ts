import { prisma } from '../db';

/** Every state change leaves a line here. */
export async function recordAudit(actorId: string | null, action: string, subject: string) {
  await prisma.auditLog.create({ data: { actorId, action, subject } });
}
