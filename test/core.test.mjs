// Testa o schema e as regras contra um Postgres de verdade (PGlite, roda em WASM).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadState, saveState, patchEntries, upsertUser, listUsers, setRole, HttpError } from '../lib/core.js';

const pg = new PGlite();
const wrap = q => ({ rows: q.rows, rowCount: q.affectedRows ?? q.rows.length });
const db = {
  query: async (t, p) => wrap(await pg.query(t, p)),
  tx: fn => pg.transaction(tx => fn(async (t, p) => wrap(await tx.query(t, p)))),
};
await pg.exec(readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8'));
await pg.exec(readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8')); // idempotente

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const rejects = async (fn, status) => {
  try { await fn(); } catch (e) { assert.ok(e instanceof HttpError, 'esperava HttpError, veio ' + e); assert.equal(e.status, status); return; }
  assert.fail('deveria ter falhado com ' + status);
};

const ADMINS = ['gestaolojarahra@gmail.com'];
const admin = await upsertUser(db, { clerkId: 'u_admin', email: 'gestaolojarahra@gmail.com', name: 'Admin', adminEmails: ADMINS, verified: true });
const ana = await upsertUser(db, { clerkId: 'u_ana', email: 'ana@x.com', name: 'Ana', adminEmails: ADMINS, verified: true });
const eve = await upsertUser(db, { clerkId: 'u_eve', email: 'eve@x.com', name: 'Eve', adminEmails: ADMINS, verified: true });

const base = () => ({
  yellow: 90, def: { tm: 190, pa: 2, conv: 30 },
  consultants: [{ id: 'c1', name: 'Ana Paula', active: true, goal: 5000 }, { id: 'c2', name: 'Beatriz', active: true, goal: 4000 }],
  weeks: [
    { id: 'w1', start: '2026-09-07', end: '2026-09-13', month: '2026-09', tm: 190, pa: 2, conv: 30, goals: { c1: 5000, c2: 4500 } },
    { id: 'w2', start: '2026-09-14', end: '2026-09-20', month: '2026-09', tm: 190, pa: 2, conv: 30, goals: {} },
  ],
  entries: { w1: { c1: { fat: 5200.5, tm: 200, pa: 2.1, conv: 31 } } },
  monthGoals: { '2026-09': { c1: 20000 } },
});

console.log('Papéis');
await ok('e-mail do admin vira admin; os outros ficam pendentes', async () => {
  assert.equal(admin.role, 'admin'); assert.equal(ana.role, 'pending'); assert.equal(eve.role, 'pending');
});
await ok('quem usa o e-mail do admin sem verificá-lo não ganha nada', async () => {
  // adminEmails vem vazio quando o e-mail não está verificado (ver lib/auth.js); o e-mail já é do admin
  // real, então o índice único barra a conta falsa em vez de deixá-la assumir o papel.
  await assert.rejects(() => upsertUser(db, { clerkId: 'u_fake', email: 'GestaoLojaRahra@gmail.com', name: 'Fake', adminEmails: [], verified: false }));
  const { rows } = await db.query("select clerk_id, role from app_users where lower(email) = 'gestaolojarahra@gmail.com'");
  assert.deepEqual(rows, [{ clerk_id: 'u_admin', role: 'admin' }]);
});

console.log('Cadastros');
let version;
await ok('estado inicial vazio', async () => {
  const r = await loadState(db);
  assert.equal(r.version, 1); assert.deepEqual(r.state.consultants, []); assert.deepEqual(r.state.weeks, []);
  version = r.version;
});
await ok('pendente e viewer não gravam cadastros', async () => {
  await rejects(() => saveState(db, ana, { version, state: base() }), 403);
  await setRole(db, admin, { clerk_id: 'u_ana', role: 'viewer' }, ADMINS);
  const ana2 = { ...ana, role: 'viewer' };
  await rejects(() => saveState(db, ana2, { version, state: base() }), 403);
});
await ok('admin salva cadastros + importa lançamentos', async () => {
  const out = await saveState(db, admin, { version, state: base(), replaceEntries: true });
  assert.equal(out.version, 2); version = out.version;
  const r = await loadState(db);
  assert.equal(r.state.consultants.length, 2);
  assert.equal(r.state.consultants[0].name, 'Ana Paula');
  assert.equal(r.state.weeks[0].start, '2026-09-07');
  assert.equal(r.state.weeks[0].month, '2026-09');
  assert.deepEqual(r.state.weeks[0].goals, { c1: 5000, c2: 4500 });
  assert.deepEqual(r.state.entries.w1.c1, { fat: 5200.5, tm: 200, pa: 2.1, conv: 31 });
  assert.equal(r.state.monthGoals['2026-09'].c1, 20000);
  assert.deepEqual(r.state.def, { tm: 190, pa: 2, conv: 30 });
});
await ok('conflito de versão devolve 409 sem gravar', async () => {
  const s = base(); s.consultants[0].name = 'STALE';
  const out = await saveState(db, admin, { version: 1, state: s });
  assert.equal(out.conflict, true); assert.equal(out.version, 2);
  assert.equal((await loadState(db)).state.consultants[0].name, 'Ana Paula');
});
await ok('salvar cadastros sem replaceEntries preserva lançamentos', async () => {
  const s = base(); s.entries = {}; s.consultants[1].name = 'Beatriz M.';
  const out = await saveState(db, admin, { version, state: s }); version = out.version;
  const r = await loadState(db);
  assert.equal(r.state.consultants[1].name, 'Beatriz M.');
  assert.equal(r.state.entries.w1.c1.fat, 5200.5);
});
await ok('validação rejeita dados ruins', async () => {
  for (const mut of [
    s => { s.consultants[0].id = 'x"><img>'; },
    s => { s.weeks[0].start = 'ontem'; },
    s => { s.yellow = 0; },
    s => { s.consultants[0].name = '  '; },
    s => { s.weeks[0].tm = -1; },
    s => { s.consultants.push({ ...s.consultants[0] }); },
  ]) { const s = base(); mut(s); await rejects(() => saveState(db, admin, { version, state: s }), 400); }
  assert.equal((await loadState(db)).version, version);
});

console.log('Lançamentos por célula');
const editor = { ...eve, role: 'editor' };
await ok('editor lança só células; viewer e pendente não', async () => {
  await rejects(() => patchEntries(db, { ...ana, role: 'viewer' }, { cells: [{ w: 'w2', c: 'c1', k: 'fat', v: 1 }] }), 403);
  await rejects(() => patchEntries(db, eve, { cells: [{ w: 'w2', c: 'c1', k: 'fat', v: 1 }] }), 403);
  await patchEntries(db, editor, { cells: [
    { w: 'w2', c: 'c1', k: 'fat', v: 4321.99 }, { w: 'w2', c: 'c1', k: 'tm', v: 180 },
    { w: 'w2', c: 'c1', k: 'fat', v: 4400 }, // duplicada: a última vence
  ] });
  const r = await loadState(db);
  assert.deepEqual(r.state.entries.w2.c1, { fat: 4400, tm: 180 });
  assert.equal(r.state.entries.w1.c1.fat, 5200.5, 'não mexeu nas outras células');
  assert.equal(r.version, version, 'lançar valores não sobe a versão dos cadastros');
});
await ok('apagar o último valor remove a linha', async () => {
  await patchEntries(db, editor, { cells: [{ w: 'w2', c: 'c1', k: 'fat', v: null }, { w: 'w2', c: 'c1', k: 'tm', v: null }] });
  assert.equal((await loadState(db)).state.entries.w2, undefined);
});
await ok('células inválidas e ids inexistentes', async () => {
  await rejects(() => patchEntries(db, editor, { cells: [{ w: 'w1', c: 'c1', k: 'conv', v: 150 }] }), 400);
  await rejects(() => patchEntries(db, editor, { cells: [{ w: 'w1', c: 'c1', k: 'fat', v: -5 }] }), 400);
  await rejects(() => patchEntries(db, editor, { cells: [{ w: 'w1', c: 'c1', k: 'id; drop table entries', v: 5 }] }), 400);
  await patchEntries(db, editor, { cells: [{ w: 'nao-existe', c: 'c1', k: 'fat', v: 5 }] }); // ignorada, sem erro
  assert.equal((await loadState(db)).state.entries['nao-existe'], undefined);
});
await ok('excluir consultora e semana apaga em cascata', async () => {
  const s = base(); s.consultants = [s.consultants[0]]; s.weeks = [s.weeks[1]]; s.entries = {};
  const out = await saveState(db, admin, { version, state: s }); version = out.version;
  const r = await loadState(db);
  assert.equal(r.state.consultants.length, 1); assert.equal(r.state.weeks.length, 1);
  assert.deepEqual(r.state.entries, {});
  assert.equal((await db.query('select count(*)::int as n from week_goals')).rows[0].n, 0);
});

console.log('Usuários');
await ok('só admin lista e muda papéis; não muda o próprio nem o admin fixo', async () => {
  await rejects(() => listUsers(db, editor), 403);
  const us = await listUsers(db, admin);
  assert.equal(us.length, 3);
  assert.equal(us[0].role, 'pending', 'pendentes primeiro');
  await rejects(() => setRole(db, editor, { clerk_id: 'u_ana', role: 'admin' }, ADMINS), 403);
  await rejects(() => setRole(db, admin, { clerk_id: 'u_admin', role: 'viewer' }, ADMINS), 400);
  await rejects(() => setRole(db, admin, { clerk_id: 'u_ana', role: 'root' }, ADMINS), 400);
  await rejects(() => setRole(db, admin, { clerk_id: 'nada', role: 'viewer' }, ADMINS), 404);
  await setRole(db, admin, { clerk_id: 'u_eve', role: 'editor' }, ADMINS);
  assert.equal((await db.query("select role from app_users where clerk_id='u_eve'")).rows[0].role, 'editor');
});
await ok('conta recriada no Clerk mantém o papel', async () => {
  const again = await upsertUser(db, { clerkId: 'u_eve_2', email: 'EVE@x.com', name: 'Eve', adminEmails: ADMINS, verified: true });
  assert.equal(again.role, 'editor'); assert.equal(again.clerk_id, 'u_eve_2');
});
await ok('auditoria registrou as gravações', async () => {
  const { rows } = await db.query('select action, count(*)::int as n from audit_log group by 1 order by 1');
  assert.ok(rows.find(r => r.action === 'lancar-valores') && rows.find(r => r.action === 'salvar-cadastros') && rows.find(r => r.action === 'mudar-papel'));
});

console.log(`\n${n} testes passaram.`);
