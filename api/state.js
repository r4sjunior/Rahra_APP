import { authenticate, route, readBody } from '../lib/auth.js';
import { loadState, saveState, allowed, HttpError } from '../lib/core.js';

// GET  -> estado completo { version, state }
// PUT  -> salva cadastros (só admin). Corpo: { version, state, replaceEntries? }
export const make = auth =>
  route(async (req, res) => {
    const { db, user } = await auth(req);
    if (req.method === 'GET') {
      if (!allowed(user.role, 'read')) throw new HttpError(403, 'Seu acesso ainda não foi liberado.');
      return loadState(db);
    }
    if (req.method === 'PUT') {
      const out = await saveState(db, user, readBody(req));
      if (out.conflict) {
        res.status(409).json({ error: 'Os cadastros foram alterados por outra pessoa.', version: out.version });
        return;
      }
      return out;
    }
    res.setHeader('Allow', 'GET, PUT');
    throw new HttpError(405, 'Método não permitido.');
  });
export default make(authenticate);
