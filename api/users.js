import { authenticate, route, readBody, adminEmails } from '../lib/auth.js';
import { listUsers, setRole, HttpError } from '../lib/core.js';

// GET   -> lista usuários (admin)
// PATCH -> muda o papel. Corpo: { clerk_id, role }
export const make = auth =>
  route(async req => {
    const { db, user } = await auth(req);
    if (req.method === 'GET') return { users: await listUsers(db, user) };
    if (req.method === 'PATCH') return setRole(db, user, readBody(req), adminEmails());
    throw new HttpError(405, 'Método não permitido.');
  });
export default make(authenticate);
