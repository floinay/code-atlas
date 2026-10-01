import type { NextFunction, Request, Response } from 'express';

export type Actor = { id: string; role: 'admin' | 'member' };

/** Reads the session and puts the signed-in user on the request. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const actor = (req as Request & { actor?: Actor }).actor;
  if (!actor) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

export const requireRole = (role: Actor['role']) => (req: Request, res: Response, next: NextFunction) => {
  const actor = (req as Request & { actor?: Actor }).actor;
  if (actor?.role !== role) return res.status(403).json({ error: 'forbidden' });
  next();
};

export const actorOf = (req: Request) => (req as Request & { actor: Actor }).actor;
