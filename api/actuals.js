import { authenticate, route, readBody } from '../lib/auth.js';
import { patchActuals, HttpError } from '../lib/core.js';

// PATCH -> grava o resultado real (não meta) de ticket médio, PA e conversão.
// Corpo: { items: [{ scope:'week', id, k, v } | { scope:'mcons', month, cid, k, v } | { scope:'mstore', month, k, v }] }
export const make = auth =>
  route(async req => {
    if (req.method !== 'PATCH' && req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
    const { db, user } = await auth(req);
    return patchActuals(db, user, readBody(req));
  });
export default make(authenticate);
