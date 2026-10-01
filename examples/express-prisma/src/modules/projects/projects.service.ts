import * as z from 'zod';
import { prisma } from '../../db';
import { recordAudit } from '../../lib/audit';

export const CreateProject = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(40),
});
export const RenameProject = CreateProject.pick({ name: true });
export const AddMember = z.object({ userId: z.string() });

export function listProjects(userId: string) {
  return prisma.project.findMany({
    where: { archivedAt: null, members: { some: { userId } } },
    orderBy: { createdAt: 'desc' },
  });
}

export function getProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: { members: { include: { user: true } }, tasks: true },
  });
}

/** The creator becomes the first member, in the same transaction. */
export async function createProject(actorId: string, input: z.infer<typeof CreateProject>) {
  const project = await prisma.project.create({
    data: { ...input, members: { create: { userId: actorId } } },
  });
  await recordAudit(actorId, 'project.created', project.id);
  return project;
}

export function renameProject(id: string, input: z.infer<typeof RenameProject>) {
  return prisma.project.update({ where: { id }, data: input });
}

export async function archiveProject(actorId: string, id: string) {
  const project = await prisma.project.update({ where: { id }, data: { archivedAt: new Date() } });
  await recordAudit(actorId, 'project.archived', id);
  return project;
}

export function addMember(projectId: string, userId: string) {
  return prisma.projectMember.create({ data: { projectId, userId } });
}

export async function removeMember(projectId: string, userId: string) {
  await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
}

export function projectStats(id: string) {
  return prisma.task.groupBy({ by: ['status'], where: { projectId: id }, _count: true });
}
