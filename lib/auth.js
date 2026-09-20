// Autenticação: valida o token de sessão do Clerk e descobre o papel do usuário no banco.
import { verifyToken, createClerkClient } from '@clerk/backend';
import { getDb } from './db.js';
import { HttpError, upsertUser } from './core.js';

export const adminEmails = () =>
  (process.env.ADMIN_EMAILS || 'gestaolojarahra@gmail.com')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

let clerk;

export async function authenticate(req) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new HttpError(500, 'CLERK_SECRET_KEY não configurada.');
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'Entre para continuar.');

  let payload;
  try {
    const opts = { secretKey };
    if (process.env.APP_ORIGIN) opts.authorizedParties = process.env.APP_ORIGIN.split(',').map(s => s.trim());
    payload = await verifyToken(m[1], opts);
  } catch {
    throw new HttpError(401, 'Sessão expirada. Entre de novo.');
  }

  const db = getDb();
  let row = (await db.query('select clerk_id, email, name, role from app_users where clerk_id = $1', [payload.sub])).rows[0];
  const admins = adminEmails();
  // Só consulta o Clerk na primeira vez (ou se o e-mail fixo de admin ainda não foi promovido).
  if (!row || (admins.includes((row.email || '').toLowerCase()) && row.role !== 'admin')) {
    clerk ||= createClerkClient({ secretKey });
    const u = await clerk.users.getUser(payload.sub);
    const primary = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId) || u.emailAddresses[0];
    if (!primary) throw new HttpError(403, 'Conta sem e-mail.');
    const verified = primary.verification && primary.verification.status === 'verified';
    const email = primary.emailAddress.toLowerCase();
    row = await upsertUser(db, {
      clerkId: payload.sub,
      email,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
      // admin fixo só vale com e-mail verificado (senão qualquer um cadastraria o e-mail do admin)
      adminEmails: verified ? admins : [],
      verified,
    });
  } else {
    await db.query('update app_users set last_seen_at = now() where clerk_id = $1', [payload.sub]);
  }
  return { db, user: row };
}

// Envolve um handler: trata erros e devolve JSON.
export function route(handler) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const out = await handler(req, res);
      if (!res.writableEnded) res.status(200).json(out);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      console.error(e);
      res.status(500).json({ error: 'Erro no servidor.' });
    }
  };
}

export function readBody(req) {
  return req.body && typeof req.body === 'object' ? req.body : (() => { throw new HttpError(400, 'Corpo inválido.'); })();
}
