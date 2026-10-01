import * as z from 'zod';
import { prisma } from '../../db';
import { recordAudit } from '../../lib/audit';

export const InviteUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: z.enum(['admin', 'member']).default('member'),
});
export const UpdateProfile = z.object({ name: z.string().min(1).max(120) });

export function listUsers() {
  return prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
}

export function getUser(id: string) {
  return prisma.user.findUnique({ where: { id }, include: { memberships: true } });
}

export async function inviteUser(actorId: string, input: z.infer<typeof InviteUser>) {
  const user = await prisma.user.create({ data: input });
  await recordAudit(actorId, 'user.invited', user.id);
  return user;
}

export async function updateProfile(id: string, input: z.infer<typeof UpdateProfile>) {
  return prisma.user.update({ where: { id }, data: input });
}

export async function removeUser(actorId: string, id: string) {
  await prisma.user.delete({ where: { id } });
  await recordAudit(actorId, 'user.removed', id);
}
