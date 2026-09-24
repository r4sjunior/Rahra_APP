// Regras do painel: leitura/gravação do estado e permissões.
// Não conhece Vercel nem Clerk: recebe um "db" com { query(text, params), tx(fn) }.
// Assim dá para testar com um Postgres de verdade (ver test/core.test.mjs).

export const ROLES = ['admin', 'editor', 'viewer', 'pending'];
export const KEYS = ['fat', 'tm', 'pa', 'conv'];
/* Ticket médio, PA e conversão são proporções (valor ÷ vendas, peças ÷ vendas, vendas ÷ atendimentos):
   não dá para reconstruir o resultado da semana/mês só somando os lançamentos, por isso são digitados
   à mão em cada nível (semana da loja, mês de cada consultora, mês da loja) — ver patchActuals. */
export const RESULT_KEYS = ['tm', 'pa', 'conv'];

const can = {
  read: r => r === 'admin' || r === 'editor' || r === 'viewer',
  entries: r => r === 'admin' || r === 'editor',
  structure: r => r === 'admin',
  users: r => r === 'admin',
};
export const allowed = (role, what) => !!can[what] && can[what](role);

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ---------- Validação (o servidor não confia no navegador) ---------- */
const ID = /^[\w-]{1,40}$/;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isMonth = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const num = v => (v === null || v === '' || v === undefined ? null : Number.isFinite(+v) ? +v : NaN);
const monthOfDates = (a, b) => {
  const cnt = {};
  const e = new Date(b + 'T00:00:00Z');
  let n = 0;
  for (let d = new Date(a + 'T00:00:00Z'); d <= e && n < 40; d = new Date(d.getTime() + 864e5), n++) {
    const k = d.toISOString().slice(0, 7);
    cnt[k] = (cnt[k] || 0) + 1;
  }
  let best = null;
  for (const k of Object.keys(cnt)) if (best == null || cnt[k] >= cnt[best]) best = k;
  return best || a.slice(0, 7);
};

function need(cond, msg) {
  if (!cond) throw new HttpError(400, msg);
}

export function sanitizeStructure(s) {
  need(s && typeof s === 'object', 'Corpo inválido.');
  const yellow = Math.round(+s.yellow);
  need(yellow >= 1 && yellow <= 100, 'Percentual de amarelo inválido.');
  const d = s.def || {};
  const def = { tm: +d.tm, pa: +d.pa, conv: +d.conv };
  need(Object.values(def).every(v => Number.isFinite(v) && v > 0), 'Metas padrão inválidas.');

  const cons = [];
  const cid = new Set();
  need(Array.isArray(s.consultants) && s.consultants.length <= 200, 'Consultoras inválidas.');
  s.consultants.forEach((c, i) => {
    need(c && ID.test(String(c.id)) && !cid.has(String(c.id)), 'Id de consultora inválido.');
    const name = String(c.name == null ? '' : c.name).trim().slice(0, 80);
    need(name, 'Consultora sem nome.');
    const goal = num(c.goal) ?? 0;
    need(goal >= 0, 'Meta de consultora inválida.');
    cid.add(String(c.id));
    cons.push({ id: String(c.id), name, active: c.active !== false, goal, ord: i });
  });

  const weeks = [];
  const wid = new Set();
  const wgoals = [];
  need(Array.isArray(s.weeks) && s.weeks.length <= 2000, 'Semanas inválidas.');
  s.weeks.forEach(w => {
    need(w && ID.test(String(w.id)) && !wid.has(String(w.id)), 'Id de semana inválido.');
    need(isDate(w.start) && isDate(w.end), 'Data de semana inválida.');
    const month = isMonth(w.month) ? w.month : monthOfDates(w.start, w.end);
    const x = { id: String(w.id), start_date: w.start, end_date: w.end, month, tm: +w.tm, pa: +w.pa, conv: +w.conv };
    need([x.tm, x.pa, x.conv].every(v => Number.isFinite(v) && v > 0), 'Metas da semana inválidas.');
    wid.add(x.id);
    weeks.push(x);
    const g = w.goals && typeof w.goals === 'object' ? w.goals : {};
    for (const k of Object.keys(g)) {
      const v = +g[k];
      if (cid.has(k) && Number.isFinite(v) && v >= 0) wgoals.push({ week_id: x.id, consultant_id: k, goal: v });
    }
  });

  const mgoals = [];
  const M = s.monthGoals && typeof s.monthGoals === 'object' ? s.monthGoals : {};
  for (const m of Object.keys(M)) {
    if (!isMonth(m) || !M[m] || typeof M[m] !== 'object') continue;
    for (const k of Object.keys(M[m])) {
      const v = +M[m][k];
      if (cid.has(k) && Number.isFinite(v) && v >= 0) mgoals.push({ month: m, consultant_id: k, goal: v });
    }
  }
  return { yellow, def, cons, weeks, wgoals, mgoals, cid, wid };
}

export function sanitizeEntries(E, cid, wid) {
  const rows = [];
  if (!E || typeof E !== 'object') return rows;
  for (const w of Object.keys(E)) {
    if (!wid.has(w) || !E[w] || typeof E[w] !== 'object') continue;
    for (const c of Object.keys(E[w])) {
      if (!cid.has(c) || !E[w][c] || typeof E[w][c] !== 'object') continue;
      const r = { week_id: w, consultant_id: c };
      let any = false;
      for (const k of KEYS) {
        const v = num(E[w][c][k]);
        r[k] = v != null && Number.isFinite(v) && v >= 0 && !(k === 'conv' && v > 100) ? v : null;
        if (r[k] != null) any = true;
      }
      if (any) rows.push(r);
    }
  }
  return rows;
}

/* ---------- Leitura ---------- */
export async function loadState(db) {
  const q = (t, p) => db.query(t, p).then(r => r.rows);
  const [st] = await q('select yellow, def_tm::float8 as tm, def_pa::float8 as pa, def_conv::float8 as conv, version from settings where id = 1');
  const cons = await q('select id, name, active, goal::float8 as goal from consultants order by position, name');
  const weeks = await q(`select id, to_char(start_date,'YYYY-MM-DD') as start, to_char(end_date,'YYYY-MM-DD') as "end",
                                month, goal_tm::float8 as tm, goal_pa::float8 as pa, goal_conv::float8 as conv
                           from weeks order by start_date`);
  const wg = await q('select week_id, consultant_id, goal::float8 as goal from week_goals');
  const mg = await q('select month, consultant_id, goal::float8 as goal from month_goals');
  const en = await q('select week_id, consultant_id, fat::float8 as fat, tm::float8 as tm, pa::float8 as pa, conv::float8 as conv from entries');
  const wa = await q('select week_id, tm::float8 as tm, pa::float8 as pa, conv::float8 as conv from week_actuals');
  const ma = await q('select month, consultant_id, tm::float8 as tm, pa::float8 as pa, conv::float8 as conv from month_actuals');
  const msa = await q('select month, tm::float8 as tm, pa::float8 as pa, conv::float8 as conv from month_store_actuals');

  const byId = {};
  const wOut = weeks.map(w => (byId[w.id] = { ...w, goals: {} }));
  wg.forEach(r => byId[r.week_id] && (byId[r.week_id].goals[r.consultant_id] = r.goal));
  const monthGoals = {};
  mg.forEach(r => ((monthGoals[r.month.trim()] ||= {})[r.consultant_id] = r.goal));
  const entries = {};
  en.forEach(r => {
    const o = {};
    KEYS.forEach(k => r[k] != null && (o[k] = r[k]));
    if (Object.keys(o).length) (entries[r.week_id] ||= {})[r.consultant_id] = o;
  });
  const pick = r => {
    const o = {};
    RESULT_KEYS.forEach(k => r[k] != null && (o[k] = r[k]));
    return o;
  };
  const weekActuals = {};
  wa.forEach(r => { const o = pick(r); if (Object.keys(o).length) weekActuals[r.week_id] = o; });
  const monthActuals = {};
  ma.forEach(r => { const o = pick(r); if (Object.keys(o).length) (monthActuals[r.month.trim()] ||= {})[r.consultant_id] = o; });
  const monthStore = {};
  msa.forEach(r => { const o = pick(r); if (Object.keys(o).length) monthStore[r.month.trim()] = o; });
  return {
    version: st.version,
    state: {
      v: 2,
      demo: false,
      yellow: st.yellow,
      def: { tm: st.tm, pa: st.pa, conv: st.conv },
      consultants: cons,
      weeks: wOut.map(w => ({ ...w, month: w.month.trim() })),
      entries,
      monthGoals,
      weekActuals,
      monthActuals,
      monthStore,
    },
  };
}

/* ---------- Gravação de cadastros (só admin) ---------- */
const jsonRows = rows => JSON.stringify(rows);

async function writeEntries(q, rows, email, replaceAll) {
  if (replaceAll) await q('delete from entries');
  await q(
    `insert into entries (week_id, consultant_id, fat, tm, pa, conv, updated_by)
     select week_id, consultant_id, fat, tm, pa, conv, $2
       from jsonb_to_recordset($1::jsonb) as x(week_id text, consultant_id text, fat numeric, tm numeric, pa numeric, conv numeric)`,
    [jsonRows(rows), email]
  );
}

export async function saveState(db, user, body) {
  if (!allowed(user.role, 'structure')) throw new HttpError(403, 'Só o administrador altera cadastros.');
  need(body && typeof body === 'object', 'Corpo inválido.');
  const S = sanitizeStructure(body.state);
  const base = Number(body.version);
  const entryRows = body.replaceEntries ? sanitizeEntries(body.state.entries, S.cid, S.wid) : null;

  return db.tx(async q => {
    const cur = (await q('select version from settings where id = 1 for update')).rows[0];
    if (cur.version !== base) return { conflict: true, version: cur.version };

    await q(
      'update settings set yellow = $1, def_tm = $2, def_pa = $3, def_conv = $4 where id = 1',
      [S.yellow, S.def.tm, S.def.pa, S.def.conv]
    );
    await q(
      `insert into consultants (id, name, active, goal, position)
       select id, name, active, goal, ord from jsonb_to_recordset($1::jsonb) as x(id text, name text, active boolean, goal numeric, ord int)
       on conflict (id) do update set name = excluded.name, active = excluded.active, goal = excluded.goal, position = excluded.position`,
      [jsonRows(S.cons)]
    );
    await q(
      `insert into weeks (id, start_date, end_date, month, goal_tm, goal_pa, goal_conv)
       select id, start_date, end_date, month, tm, pa, conv
         from jsonb_to_recordset($1::jsonb) as x(id text, start_date date, end_date date, month text, tm numeric, pa numeric, conv numeric)
       on conflict (id) do update set start_date = excluded.start_date, end_date = excluded.end_date, month = excluded.month,
                                      goal_tm = excluded.goal_tm, goal_pa = excluded.goal_pa, goal_conv = excluded.goal_conv`,
      [jsonRows(S.weeks)]
    );
    // O que sumiu do cadastro é apagado (lançamentos e metas caem junto, por cascata).
    await q('delete from consultants where id <> all($1::text[])', [S.cons.map(c => c.id)]);
    await q('delete from weeks where id <> all($1::text[])', [S.weeks.map(w => w.id)]);
    await q('delete from week_goals');
    await q('delete from month_goals');
    await q(
      `insert into week_goals (week_id, consultant_id, goal)
       select week_id, consultant_id, goal from jsonb_to_recordset($1::jsonb) as x(week_id text, consultant_id text, goal numeric)`,
      [jsonRows(S.wgoals)]
    );
    await q(
      `insert into month_goals (month, consultant_id, goal)
       select month, consultant_id, goal from jsonb_to_recordset($1::jsonb) as x(month text, consultant_id text, goal numeric)`,
      [jsonRows(S.mgoals)]
    );
    if (entryRows) await writeEntries(q, entryRows, user.email, true);

    const v = (await q('update settings set version = version + 1, updated_at = now(), updated_by = $1 where id = 1 returning version', [user.email])).rows[0].version;
    await q('insert into audit_log (user_email, role, action, detail) values ($1, $2, $3, $4)', [
      user.email,
      user.role,
      body.replaceEntries ? 'restaurar-backup' : 'salvar-cadastros',
      JSON.stringify({ consultoras: S.cons.length, semanas: S.weeks.length }),
    ]);
    return { version: v };
  });
}

/* ---------- Lançamentos (admin e editor) ---------- */
export async function patchEntries(db, user, body) {
  if (!allowed(user.role, 'entries')) throw new HttpError(403, 'Sem permissão para lançar valores.');
  const cells = body && Array.isArray(body.cells) ? body.cells : null;
  need(cells && cells.length <= 2000, 'Lista de células inválida.');
  const last = new Map(); // a última ocorrência de cada célula vence
  cells.forEach(c => {
    need(c && ID.test(String(c.w)) && ID.test(String(c.c)) && KEYS.includes(c.k), 'Célula inválida.');
    const v = num(c.v);
    need(v === null || (Number.isFinite(v) && v >= 0 && !(c.k === 'conv' && v > 100)), 'Valor inválido.');
    last.set(c.w + '|' + c.c + '|' + c.k, { w: String(c.w), c: String(c.c), k: c.k, v });
  });
  const clean = [...last.values()];
  return db.tx(async q => {
    let saved = 0;
    for (const k of KEYS) {
      const rows = clean.filter(c => c.k === k).map(c => ({ week_id: c.w, consultant_id: c.c, val: c.v }));
      if (!rows.length) continue;
      // "k" vem da lista fixa KEYS: seguro para compor o nome da coluna.
      const r = await q(
        `insert into entries (week_id, consultant_id, ${k}, updated_by)
         select x.week_id, x.consultant_id, x.val, $2
           from jsonb_to_recordset($1::jsonb) as x(week_id text, consultant_id text, val numeric)
          where exists (select 1 from weeks w where w.id = x.week_id)
            and exists (select 1 from consultants c where c.id = x.consultant_id)
         on conflict (week_id, consultant_id) do update set ${k} = excluded.${k}, updated_at = now(), updated_by = excluded.updated_by`,
        [jsonRows(rows), user.email]
      );
      saved += r.rowCount ?? 0;
    }
    await q('delete from entries where fat is null and tm is null and pa is null and conv is null');
    await q('insert into audit_log (user_email, role, action, detail) values ($1, $2, $3, $4)', [
      user.email, user.role, 'lancar-valores', JSON.stringify({ celulas: clean.length }),
    ]);
    return { saved };
  });
}

/* ---------- Resultado real de TM/PA/conversão (digitado à mão; admin e editor) ---------- */
export async function patchActuals(db, user, body) {
  if (!allowed(user.role, 'entries')) throw new HttpError(403, 'Sem permissão para lançar resultados.');
  const items = body && Array.isArray(body.items) ? body.items : null;
  need(items && items.length <= 2000, 'Lista inválida.');
  const last = new Map();
  items.forEach(it => {
    need(it && RESULT_KEYS.includes(it.k), 'Indicador inválido.');
    const v = num(it.v);
    need(v === null || (Number.isFinite(v) && v >= 0 && !(it.k === 'conv' && v > 100)), 'Valor inválido.');
    if (it.scope === 'week') {
      need(ID.test(String(it.id)), 'Semana inválida.');
      last.set('week|' + it.id + '|' + it.k, { scope: 'week', id: String(it.id), k: it.k, v });
    } else if (it.scope === 'mcons') {
      need(isMonth(it.month) && ID.test(String(it.cid)), 'Mês ou consultora inválidos.');
      last.set('mcons|' + it.month + '|' + it.cid + '|' + it.k, { scope: 'mcons', month: it.month, cid: String(it.cid), k: it.k, v });
    } else if (it.scope === 'mstore') {
      need(isMonth(it.month), 'Mês inválido.');
      last.set('mstore|' + it.month + '|' + it.k, { scope: 'mstore', month: it.month, k: it.k, v });
    } else need(false, 'Escopo inválido.');
  });
  const clean = [...last.values()];
  return db.tx(async q => {
    let saved = 0;
    for (const k of RESULT_KEYS) {
      const wRows = clean.filter(c => c.scope === 'week' && c.k === k).map(c => ({ week_id: c.id, val: c.v }));
      if (wRows.length) {
        const r = await q(
          `insert into week_actuals (week_id, ${k}, updated_by)
           select x.week_id, x.val, $2 from jsonb_to_recordset($1::jsonb) as x(week_id text, val numeric)
            where exists (select 1 from weeks w where w.id = x.week_id)
           on conflict (week_id) do update set ${k} = excluded.${k}, updated_at = now(), updated_by = excluded.updated_by`,
          [jsonRows(wRows), user.email]
        );
        saved += r.rowCount ?? 0;
      }
      const cRows = clean.filter(c => c.scope === 'mcons' && c.k === k).map(c => ({ month: c.month, consultant_id: c.cid, val: c.v }));
      if (cRows.length) {
        const r = await q(
          `insert into month_actuals (month, consultant_id, ${k}, updated_by)
           select x.month, x.consultant_id, x.val, $2 from jsonb_to_recordset($1::jsonb) as x(month text, consultant_id text, val numeric)
            where exists (select 1 from consultants c where c.id = x.consultant_id)
           on conflict (month, consultant_id) do update set ${k} = excluded.${k}, updated_at = now(), updated_by = excluded.updated_by`,
          [jsonRows(cRows), user.email]
        );
        saved += r.rowCount ?? 0;
      }
      const sRows = clean.filter(c => c.scope === 'mstore' && c.k === k).map(c => ({ month: c.month, val: c.v }));
      if (sRows.length) {
        const r = await q(
          `insert into month_store_actuals (month, ${k}, updated_by)
           select x.month, x.val, $2 from jsonb_to_recordset($1::jsonb) as x(month text, val numeric)
           on conflict (month) do update set ${k} = excluded.${k}, updated_at = now(), updated_by = excluded.updated_by`,
          [jsonRows(sRows), user.email]
        );
        saved += r.rowCount ?? 0;
      }
    }
    await q('delete from week_actuals where tm is null and pa is null and conv is null');
    await q('delete from month_actuals where tm is null and pa is null and conv is null');
    await q('delete from month_store_actuals where tm is null and pa is null and conv is null');
    await q('insert into audit_log (user_email, role, action, detail) values ($1, $2, $3, $4)', [
      user.email, user.role, 'lancar-resultados', JSON.stringify({ itens: clean.length }),
    ]);
    return { saved };
  });
}

/* ---------- Usuários ---------- */
export async function upsertUser(db, { clerkId, email, name, adminEmails, verified = false }) {
  const isAdmin = adminEmails.includes(email.toLowerCase());
  // Conta recriada no Clerk (novo id, mesmo e-mail verificado): mantém o papel que a pessoa já tinha.
  if (verified) await db.query('update app_users set clerk_id = $1 where lower(email) = lower($2) and clerk_id <> $1', [clerkId, email]);
  const { rows } = await db.query(
    `insert into app_users (clerk_id, email, name, role)
     values ($1, $2, $3, $4)
     on conflict (clerk_id) do update
       set email = excluded.email, name = excluded.name, last_seen_at = now(),
           role = case when $5 then 'admin' else app_users.role end
     returning clerk_id, email, name, role`,
    [clerkId, email, name, isAdmin ? 'admin' : 'pending', isAdmin]
  );
  return rows[0];
}

export async function listUsers(db, user) {
  if (!allowed(user.role, 'users')) throw new HttpError(403, 'Só o administrador vê os usuários.');
  const { rows } = await db.query(
    `select clerk_id, email, name, role, to_char(last_seen_at at time zone 'America/Fortaleza','DD/MM/YYYY HH24:MI') as last_seen
       from app_users order by (role = 'pending') desc, lower(email)`
  );
  return rows;
}

export async function setRole(db, user, { clerk_id, role }, adminEmails) {
  if (!allowed(user.role, 'users')) throw new HttpError(403, 'Só o administrador altera usuários.');
  need(ROLES.includes(role), 'Papel inválido.');
  need(typeof clerk_id === 'string' && clerk_id.length < 100, 'Usuário inválido.');
  if (clerk_id === user.clerk_id) throw new HttpError(400, 'Você não pode mudar o seu próprio papel.');
  const t = (await db.query('select email from app_users where clerk_id = $1', [clerk_id])).rows[0];
  if (!t) throw new HttpError(404, 'Usuário não encontrado.');
  if (adminEmails.includes(t.email.toLowerCase())) throw new HttpError(400, 'Este e-mail é administrador fixo (variável ADMIN_EMAILS).');
  await db.query('update app_users set role = $2 where clerk_id = $1', [clerk_id, role]);
  await db.query('insert into audit_log (user_email, role, action, detail) values ($1, $2, $3, $4)', [
    user.email, user.role, 'mudar-papel', JSON.stringify({ alvo: t.email, papel: role }),
  ]);
  return { ok: true };
}
