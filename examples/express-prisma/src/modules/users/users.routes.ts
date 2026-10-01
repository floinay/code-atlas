import { Router } from 'express';
import { actorOf, requireAuth, requireRole } from '../../middleware/auth';
import { getUser, InviteUser, inviteUser, listUsers, removeUser, UpdateProfile, updateProfile } from './users.service';

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get('/', async (_req, res) => {
  res.json(await listUsers());
});

/** The signed-in user's own profile. */
usersRouter.get('/me', async (req, res) => {
  res.json(await getUser(actorOf(req).id));
});

usersRouter.get('/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  res.json(user);
});

/** Invites a person. Only admins can. */
usersRouter.post('/', requireRole('admin'), async (req, res) => {
  const input = InviteUser.parse(req.body);
  res.status(201).json(await inviteUser(actorOf(req).id, input));
});

usersRouter.patch('/me', async (req, res) => {
  res.json(await updateProfile(actorOf(req).id, UpdateProfile.parse(req.body)));
});

usersRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  await removeUser(actorOf(req).id, req.params.id);
  res.sendStatus(204);
});
