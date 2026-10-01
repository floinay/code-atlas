import * as z from 'zod';
import { prisma } from '../../db';
import { recordAudit } from '../../lib/audit';
import { sendMail } from '../../lib/mailer';

export const TaskStatus = z.enum(['todo', 'doing', 'done']);
export const CreateTask = z.object({
  title: z.string().min(1).max(200),
  assigneeId: z.string().optional(),
  dueAt: z.iso.datetime().optional(),
});
export const UpdateTask = CreateTask.partial();
export const MoveTask = z.object({ status: TaskStatus });
export const SearchTasks = z.object({
  text: z.string().min(2),
  status: TaskStatus.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const AddComment = z.object({ body: z.string().min(1).max(2000) });

export function listTasks(projectId: string) {
  return prisma.task.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } });
}

export function getTask(id: string) {
  return prisma.task.findUnique({ where: { id }, include: { comments: true, assignee: true } });
}

export function searchTasks(projectId: string, query: z.infer<typeof SearchTasks>) {
  return prisma.task.findMany({
    where: { projectId, title: { contains: query.text }, status: query.status },
    take: query.limit,
  });
}

export async function createTask(actorId: string, projectId: string, input: z.infer<typeof CreateTask>) {
  const task = await prisma.task.create({ data: { ...input, projectId } });
  await recordAudit(actorId, 'task.created', task.id);
  return task;
}

export function updateTask(id: string, input: z.infer<typeof UpdateTask>) {
  return prisma.task.update({ where: { id }, data: input });
}

export function moveTask(id: string, status: z.infer<typeof TaskStatus>) {
  return prisma.task.update({ where: { id }, data: { status } });
}

export async function deleteTask(actorId: string, id: string) {
  await prisma.task.delete({ where: { id } });
  await recordAudit(actorId, 'task.deleted', id);
}

/** Adds a comment and tells the assignee about it. */
export async function addComment(actorId: string, taskId: string, body: string) {
  const comment = await prisma.comment.create({ data: { taskId, authorId: actorId, body } });
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { assignee: true } });
  if (task?.assignee) await sendMail(task.assignee.email, `New comment on ${task.title}`, body);
  return comment;
}

export function listComments(taskId: string) {
  return prisma.comment.findMany({ where: { taskId }, include: { author: true } });
}
