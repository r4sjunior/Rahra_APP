import { authenticate, route, readBody } from '../lib/auth.js';
import { patchEntries, HttpError } from '../lib/core.js';

// PATCH -> grava só as células alteradas. Corpo: { cells: [{ w, c, k, v }] }  (v = número ou null)
export const make = auth =>
  route(async req => {
    if (req.method !== 'PATCH' && req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
    const { db, user } = await auth(req);
    return patchEntries(db, user, readBody(req));
  });
export default make(authenticate);
