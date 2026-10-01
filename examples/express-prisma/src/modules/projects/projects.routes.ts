import { Router } from 'express';
import { actorOf, requireAuth, requireRole } from '../../middleware/auth';
import {
  AddMember,
  addMember,
  archiveProject,
  CreateProject,
  createProject,
  getProject,
  listProjects,
  projectStats,
  removeMember,
  RenameProject,
  renameProject,
} from './projects.service';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

projectsRouter.get('/', async (req, res) => {
  res.json(await listProjects(actorOf(req).id));
});

projectsRouter.post('/', async (req, res) => {
  const project = await createProject(actorOf(req).id, CreateProject.parse(req.body));
  res.status(201).json(project);
});

projectsRouter
  .route('/:projectId')
  .get(async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'project_not_found' });
    res.json(project);
  })
  .patch(async (req, res) => {
    res.json(await renameProject(req.params.projectId, RenameProject.parse(req.body)));
  });

/** Archived projects leave the lists; nothing is deleted. */
projectsRouter.post('/:projectId/archive', requireRole('admin'), async (req, res) => {
  res.json(await archiveProject(actorOf(req).id, req.params.projectId));
});

projectsRouter.get('/:projectId/stats', async (req, res) => {
  res.json(await projectStats(req.params.projectId));
});

projectsRouter.post('/:projectId/members', requireRole('admin'), async (req, res) => {
  const { userId } = AddMember.parse(req.body);
  res.status(201).json(await addMember(req.params.projectId, userId));
});

projectsRouter.delete('/:projectId/members/:userId', requireRole('admin'), async (req, res) => {
  await removeMember(req.params.projectId, req.params.userId);
  res.sendStatus(204);
});
