import { Router } from 'express';
import { actorOf, requireAuth } from '../../middleware/auth';
import {
  AddComment,
  addComment,
  CreateTask,
  createTask,
  deleteTask,
  getTask,
  listComments,
  listTasks,
  MoveTask,
  moveTask,
  SearchTasks,
  searchTasks,
  UpdateTask,
  updateTask,
} from './tasks.service';

/** Mounted under a project, so every path starts with its id. */
export const tasksRouter = Router({ mergeParams: true });
tasksRouter.use(requireAuth);

tasksRouter.get('/', async (req, res) => {
  res.json(await listTasks(req.params.projectId));
});

/** A POST, and still a query: it only reads. */
tasksRouter.post('/search', async (req, res) => {
  res.json(await searchTasks(req.params.projectId, SearchTasks.parse(req.body)));
});

tasksRouter.post('/', async (req, res) => {
  const task = await createTask(actorOf(req).id, req.params.projectId, CreateTask.parse(req.body));
  res.status(201).json(task);
});

tasksRouter.get('/:taskId', async (req, res) => {
  const task = await getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'task_not_found' });
  res.json(task);
});

tasksRouter.patch('/:taskId', async (req, res) => {
  res.json(await updateTask(req.params.taskId, UpdateTask.parse(req.body)));
});

tasksRouter.post('/:taskId/move', async (req, res) => {
  res.json(await moveTask(req.params.taskId, MoveTask.parse(req.body).status));
});

tasksRouter.delete('/:taskId', async (req, res) => {
  await deleteTask(actorOf(req).id, req.params.taskId);
  res.sendStatus(204);
});

tasksRouter.get('/:taskId/comments', async (req, res) => {
  res.json(await listComments(req.params.taskId));
});

tasksRouter.post('/:taskId/comments', async (req, res) => {
  const { body } = AddComment.parse(req.body);
  res.status(201).json(await addComment(actorOf(req).id, req.params.taskId, body));
});
