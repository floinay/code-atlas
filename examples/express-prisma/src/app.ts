import express from 'express';
import { projectsRouter } from './modules/projects/projects.routes';
import { tasksRouter } from './modules/tasks/tasks.routes';
import { usersRouter } from './modules/users/users.routes';

export const app = express();
app.use(express.json());

const api = express.Router();
api.use('/users', usersRouter);
api.use('/projects', projectsRouter);
api.use('/projects/:projectId/tasks', tasksRouter);
app.use('/api', api);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
