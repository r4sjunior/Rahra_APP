// Teste ponta a ponta: navegador real (Chrome) + APIs reais + Postgres real (PGlite) + Clerk simulado.
// Uso:  CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node test/e2e.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import puppeteer from 'puppeteer-core';
import { upsertUser, HttpError } from '../lib/core.js';
import { make as makeState } from '../api/state.js';
import { make as makeEntries } from '../api/entries.js';
import { make as makeActuals } from '../api/actuals.js';
import { make as makeUsers } from '../api/users.js';
import { make as makeMe } from '../api/me.js';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ADMINS = ['gestaolojarahra@gmail.com'];

const pg = new PGlite();
const wrap = q => ({ rows: q.rows, rowCount: q.affectedRows ?? q.rows.length });
const db = {
  query: async (t, p) => wrap(await pg.query(t, p)),
  tx: fn => pg.transaction(tx => fn(async (t, p) => wrap(await tx.query(t, p)))),
};
await pg.exec(readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8'));

// Autenticação falsa: o "token" é  id|email  (em produção é o token de sessão do Clerk).
const auth = async req => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'Entre para continuar.');
  const [id, email] = m[1].split('|');
  const user = await upsertUser(db, { clerkId: id, email, name: email.split('@')[0], adminEmails: ADMINS, verified: true });
  return { db, user };
};
const H = { '/api/state': makeState(auth), '/api/entries': makeEntries(auth), '/api/actuals': makeActuals(auth), '/api/users': makeUsers(auth), '/api/me': makeMe(auth) };
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ clerkPublishableKey: 'pk_test_' + Buffer.from('clerk.test.dev$').toString('base64') }));
  }
  if (H[url.pathname]) {
    let raw = '';
    for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : undefined;
    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    return H[url.pathname](req, res);
  }
  const f = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!f.startsWith(path.join(ROOT, 'public')) || !existsSync(f)) return res.writeHead(404).end();
  res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
  res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://localhost:' + server.address().port;

const FAKE_CLERK = `window.Clerk={user:window.__USER||null,async load(){},session:{getToken:async()=>window.__USER&&window.__USER.token},
  addListener(){},mountSignIn(el){el.textContent='CLERK-SIGNIN'},mountUserButton(el){el.textContent='CLERK-USER'}};`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function openAs(user) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1300, height: 900 });
  await p.setRequestInterception(true);
  p.on('request', r => (r.url().includes('clerk.test.dev') ? r.respond({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: FAKE_CLERK }) : r.continue()));
  p.on('console', m => process.env.DEBUG_E2E && console.log('  [console]', m.type(), m.text()));
  p.on('pageerror', e => errors.push((user && user.email) + ' PAGEERR ' + e.message));
  if (user) await p.evaluateOnNewDocument(u => { window.__USER = u; }, { token: user.id + '|' + user.email });
  await p.goto(BASE + '/');
  return p;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (p, fn, what, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await p.evaluate(fn).catch(() => false)) return; await sleep(80); }
  assert.fail('Tempo esgotado: ' + what);
};
const tabs = p => p.$$eval('.tab', e => e.map(x => x.textContent));
const saved = (p, what) => until(p, () => document.querySelector('#sync').textContent === 'Tudo salvo', what);
const loaded = (p, what) => until(p, () => document.querySelectorAll('.tab').length > 0, what);
let n = 0;
const ok = name => console.log('  ok  ' + name, (n++, ''));
const fetchAs = (p, url, init = {}) =>
  p.evaluate(async (url, init) => (await fetch(url, { ...init, headers: { Authorization: 'Bearer ' + window.__USER.token, 'Content-Type': 'application/json' } })).status, url, init);

const ADMIN = { id: 'u_admin', email: 'gestaolojarahra@gmail.com' };
const ED = { id: 'u_ed', email: 'lancadora@x.com' };
const VW = { id: 'u_vw', email: 'leitora@x.com' };
const PD = { id: 'u_pd', email: 'curiosa@x.com' };

try {
  console.log('Sem login');
  let p = await openAs(null);
  await until(p, () => document.querySelector('#signin') && document.querySelector('#signin').textContent === 'CLERK-SIGNIN', 'tela de login');
  ok('mostra o login do Clerk quando não há sessão');
  await p.close();

  console.log('Administrador');
  p = await openAs(ADMIN);
  await loaded(p, 'app carregou');
  assert.deepEqual(await tabs(p), ['Painel', 'Cadastros', 'Semanal', 'Mensal', 'Relatórios', 'Usuários']);
  assert.equal(await p.$eval('.tab[aria-selected=true]', e => e.textContent), 'Cadastros', 'banco vazio abre em Cadastros');
  ok('e-mail do admin entra como administrador e vê todas as abas');

  await p.click('[data-act=edit][data-key=cons]');
  await p.type('#nc-name', 'Ana Paula'); await p.click('[data-act=add-cons]');
  await p.type('#nc-name', 'Beatriz'); await p.click('[data-act=add-cons]');
  await p.click('[data-act=save-edit][data-key=cons]');
  await saved(p, 'salvou consultoras');

  await p.click('[data-act=edit][data-key=weeks]');
  await p.click('[data-act=add-week]');
  const wg = await p.$$('input[data-b^="wg:"]');
  await wg[0].focus(); await p.keyboard.type('5000'); await p.keyboard.press('Tab');
  await wg[1].focus(); await p.keyboard.type('4000'); await p.keyboard.press('Tab');
  await p.click('[data-act=save-edit][data-key=weeks]');
  await saved(p, 'salvou semanas e metas');
  const rows = (await db.query('select name, goal::float8 as goal from consultants order by position')).rows;
  assert.deepEqual(rows, [{ name: 'Ana Paula', goal: 0 }, { name: 'Beatriz', goal: 0 }]);
  assert.equal((await db.query('select count(*)::int as n from weeks')).rows[0].n, 1);
  assert.deepEqual((await db.query('select goal::float8 as goal from week_goals order by goal')).rows, [{ goal: 4000 }, { goal: 5000 }]);
  ok('cadastros vão para o banco (consultoras, semana e metas por semana) só depois de Salvar');

  await p.click('[data-act=edit][data-key=weeks]');
  const gapBtn = await p.$('[data-act=add-week-gap]');
  if (gapBtn) {
    const gap = await p.evaluate(b => ({ start: b.dataset.start, end: b.dataset.end }), gapBtn);
    await gapBtn.click();
    const lastStart = await p.$$eval('input[data-b^="w:"][data-b$=":start"]', a => a[a.length - 1].value);
    const lastEnd = await p.$$eval('input[data-b^="w:"][data-b$=":end"]', a => a[a.length - 1].value);
    assert.equal(lastStart, gap.start); assert.equal(lastEnd, gap.end);
    await p.click('[data-act=save-edit][data-key=weeks]');
    await saved(p, 'salvou período de fechamento do mês');
    assert.equal((await db.query('select count(*)::int as n from weeks')).rows[0].n, 2);
    ok('"Fechar o mês" adiciona um período até o fim do mês, mesmo com menos de 7 dias');
  } else {
    await p.click('[data-act=cancel-edit][data-key=weeks]');
  }

  const monthBefore = await p.$eval('.toolbar b', e => e.textContent);
  await p.click('[data-act=mprev]');
  const monthAfterPrev = await p.$eval('.toolbar b', e => e.textContent);
  assert.notEqual(monthAfterPrev, monthBefore, 'navegou para o mês anterior');
  await p.click('[data-act=edit][data-key=weeks]');
  await p.click('[data-act=add-week]');
  const monthOfNewWeek = await p.$eval('.toolbar b', e => e.textContent);
  assert.equal(monthOfNewWeek, monthAfterPrev, 'semana nova cadastrada num mês retroativo fica nesse mês, sem pular para a frente');
  await p.click('[data-act=save-edit][data-key=weeks]');
  await saved(p, 'salvou semana de mês retroativo');
  const monthsInDb = (await db.query('select distinct month from weeks order by month')).rows.map(r => r.month.trim());
  assert.ok(monthsInDb.length >= 2, 'agora existe semana tanto no mês retroativo quanto no mês seguinte');
  ok('cadastrar uma semana num mês anterior (retroativo) não pula para o mês seguinte');
  await p.click('[data-act=mnext]');

  await p.click('.tab[data-v=sem]');
  await p.click('[data-act=edit][data-key=ent]');
  const fat = await p.$('#grid input[data-b$=":fat"]');
  await fat.focus(); await p.keyboard.type('1.234,5'); await p.keyboard.press('Tab');
  await p.click('[data-act=save-edit][data-key=ent]');
  await saved(p, 'salvou lançamento');
  assert.deepEqual((await db.query('select fat::float8 as fat, updated_by from entries')).rows, [{ fat: 1234.5, updated_by: ADMIN.email }]);
  ok('lançamento vai para o banco só como a célula alterada, com autor');

  await p.click('[data-act=edit][data-key=ent]');
  const fat2 = await p.$('#grid input[data-b$=":fat"]');
  await fat2.focus(); await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control'); await p.keyboard.type('9999'); await p.keyboard.press('Tab');
  await p.click('[data-act=cancel-edit][data-key=ent]');
  await until(p, () => /canceladas/i.test(document.querySelector('#toast').textContent), 'aviso de cancelamento');
  assert.equal(await p.$eval('#grid input[data-b$=":fat"]', e => e.value), '1234,50', 'cancelar devolve o valor de antes da edição');
  assert.deepEqual((await db.query('select fat::float8 as fat from entries')).rows, [{ fat: 1234.5 }]);
  ok('cancelar uma edição de lançamento descarta o que foi digitado, sem gravar no banco');

  await p.click('[data-act=edit][data-key=ent]');
  const rtm = await p.$('#grid input[data-b^="wr:"][data-b$=":tm"]');
  await rtm.focus(); await p.keyboard.type('217,66'); await p.keyboard.press('Tab');
  const rpa = await p.$('#grid input[data-b^="wr:"][data-b$=":pa"]');
  await rpa.focus(); await p.keyboard.type('2,66'); await p.keyboard.press('Tab');
  await p.click('[data-act=save-edit][data-key=ent]');
  await saved(p, 'salvou resultado real da semana');
  const wkAct = (await db.query('select tm::float8 as tm, pa::float8 as pa from week_actuals')).rows;
  assert.equal(wkAct.length, 1);
  assert.equal(wkAct[0].tm, 217.66); assert.equal(wkAct[0].pa, 2.66);
  ok('ticket médio e PA reais da loja na semana são digitados à mão (não calculados) e salvos');

  await p.click('.tab[data-v=men]');
  await until(p, () => document.querySelector('#mgrid'), 'mensal carregou');
  await p.click('[data-act=edit][data-key=men]');
  const mcaTm = await p.$('#mgrid input[data-b^="mca:"][data-b$=":tm"]');
  await mcaTm.focus(); await p.keyboard.type('220'); await p.keyboard.press('Tab');
  const msaConv = await p.$('input[data-b="msa:conv"]');
  await msaConv.focus(); await p.keyboard.type('40'); await p.keyboard.press('Tab');
  await p.click('[data-act=save-edit][data-key=men]');
  await saved(p, 'salvou resultado real do mês');
  const mca = (await db.query("select tm::float8 as tm from month_actuals where consultant_id=(select id from consultants where name='Ana Paula')")).rows;
  assert.equal(mca[0].tm, 220);
  const msa = (await db.query('select conv::float8 as conv from month_store_actuals')).rows;
  assert.equal(msa[0].conv, 40);
  ok('ticket médio da consultora e conversão da loja no mês são digitados à mão (não calculados) e salvos');

  await p.click('.tab[data-v=rel]');
  await until(p, () => document.querySelector('#rep'), 'relatório carregou');
  const repBefore = await p.$eval('#rep', e => e.textContent);
  assert.equal(await p.$eval('[data-act=rep-cancel]', e => e.disabled), true, 'sem filtro pendente, Cancelar começa desabilitado');
  await p.click('[data-act=rind][data-v=pa]');
  assert.equal(await p.$eval('#rep', e => e.textContent), repBefore, 'trocar o filtro não muda o relatório antes de clicar em Gerar relatório');
  assert.equal(await p.$eval('[data-act=rep-cancel]', e => e.disabled), false, 'com filtro pendente, Cancelar fica disponível');
  await p.click('[data-act=rep-gen]');
  await p.waitForFunction(before => document.querySelector('#rep').textContent !== before, {}, repBefore);
  assert.equal(await p.$eval('[data-act=rep-cancel]', e => e.disabled), true, 'depois de gerar, Cancelar volta a ficar desabilitado');
  ok('relatório só atualiza depois de clicar em "Gerar relatório"');

  assert.equal(await p.$eval('[data-act=rind-all]', e => e.getAttribute('aria-pressed')), 'false', '"Todos" não fica marcado com um indicador desligado');
  await p.click('[data-act=rind-all]');
  assert.equal(await p.$$eval('[data-act=rind]', a => a.every(x => x.getAttribute('aria-pressed') === 'true')), true, '"Todos" liga todos os indicadores de uma vez');
  await p.click('[data-act=rind-all]');
  assert.equal(await p.$$eval('[data-act=rind]', a => a.every(x => x.getAttribute('aria-pressed') === 'false')), true, 'clicar de novo em "Todos" desliga todos');
  await p.click('[data-act=rind-all]');
  await p.click('[data-act=rep-gen]');
  ok('botão "Todos" liga/desliga todos os indicadores do relatório de uma vez');

  const pctHeaders = await p.$$eval('#rep thead th', a => a.map(e => e.textContent.trim()).filter(t => t === '% da meta'));
  assert.equal(pctHeaders.length, 2, 'só a coluna de Vendas mostra % da meta (uma vez no resumo, outra no detalhe semana a semana); Ticket médio/PA/Conversão não mostram mais');
  ok('relatório de desempenho não mostra % da meta para TM/PA/Conversão, só para Vendas');

  await p.click('[data-act=rpreset][data-v=months]');
  await p.click('[data-act=rmonth]');
  assert.equal(await p.$eval('[data-act=rind-all]', e => e.getAttribute('aria-pressed')), 'true', 'ao trocar para "Comparar meses", o filtro de indicadores continua com todos marcados');
  await p.click('[data-act=rep-gen]');
  await until(p, () => document.querySelectorAll('#rep h3.sec').length >= 4, 'comparativo entre meses com todos os indicadores gerado');
  const sections = await p.$$eval('#rep h3.sec', a => a.map(e => e.textContent));
  assert.deepEqual(sections.slice().sort(), ['Conversão', 'PA', 'Ticket médio', 'Vendas'], 'Comparar meses mostra uma tabela por indicador quando todos estão selecionados');
  ok('em "Comparar meses" dá para selecionar todos os indicadores de uma vez (antes só um por vez)');

  await p.reload();
  await loaded(p, 'recarregou');
  await p.click('.tab[data-v=sem]');
  assert.equal(await p.$eval('#grid input[data-b$=":fat"]', e => e.value), '1234,50');
  ok('depois de recarregar, o valor volta do banco');
  await p.close();

  console.log('Outros papéis');
  const pend = await openAs(PD);
  await until(pend, () => document.querySelector('.gate-card'), 'gate pendente');
  assert.match(await pend.$eval('.gate-card', e => e.textContent), /não foi liberado/);
  assert.equal(await pend.$eval('#appwrap', e => getComputedStyle(e).display), 'none');
  assert.equal(await fetchAs(pend, '/api/state'), 403);
  ok('quem não é admin entra como pendente: sem dados na tela e a API responde 403');
  await pend.close();

  p = await openAs(ADMIN);
  await loaded(p, 'admin de novo');
  await p.click('.tab[data-v=usr]');
  await until(p, () => document.querySelector('select[data-role]'), 'lista de usuários');
  const opts = await p.$$eval('select[data-role]', s => s.map(x => [x.dataset.role, x.value, x.disabled]));
  assert.deepEqual(opts.find(o => o[0] === 'u_pd'), ['u_pd', 'pending', false]);
  assert.equal(opts.find(o => o[0] === 'u_admin')[2], true, 'não muda o próprio papel');
  await p.select('select[data-role=u_pd]', 'viewer');
  await until(p, () => /Acesso atualizado/.test(document.querySelector('#toast').textContent), 'aviso de acesso atualizado');
  assert.equal((await db.query("select role from app_users where clerk_id='u_pd'")).rows[0].role, 'viewer');
  ok('admin libera um pendente pela aba Usuários');
  await p.close();

  await upsertUser(db, { clerkId: ED.id, email: ED.email, name: 'l', adminEmails: ADMINS, verified: true });
  await upsertUser(db, { clerkId: VW.id, email: VW.email, name: 'v', adminEmails: ADMINS, verified: true });
  await db.query("update app_users set role='editor' where clerk_id=$1", [ED.id]);
  await db.query("update app_users set role='viewer' where clerk_id=$1", [VW.id]);

  const ed = await openAs(ED);
  await loaded(ed, 'editor carregou');
  assert.deepEqual(await tabs(ed), ['Painel', 'Semanal', 'Mensal', 'Relatórios']);
  await ed.click('.tab[data-v=sem]');
  assert.equal(await ed.$eval('#grid input[data-b$=":fat"]', e => e.value), '1234,50', 'vê o que o admin lançou');
  await ed.click('[data-act=edit][data-key=ent]');
  const tm = (await ed.$$('#grid input[data-b$=":tm"]'))[1];
  await tm.focus(); await ed.keyboard.type('180'); await ed.keyboard.press('Tab');
  await ed.click('[data-act=save-edit][data-key=ent]');
  await saved(ed, 'editor salvou');
  assert.equal((await db.query('select updated_by from entries where tm is not null')).rows[0].updated_by, ED.email);
  await ed.click('.tab[data-v=men]');
  assert.equal(await ed.$$eval('#mgrid td.goal input', a => a.length), 0, 'meta do mês agora é só a soma das metas semanais, sem campo para editar');
  assert.equal(await ed.$$eval('#mgrid input[data-b^="mca:"], #mgrid input[data-b^="msa:"]', a => a.length > 0 && a.every(i => i.disabled)), true, 'ticket médio/PA/conversão do mês existem mas ficam travados até clicar em "Editar"');
  const anaGoalSum = (await db.query(
    `select coalesce(sum(wg.goal),0)::float8 as total from week_goals wg
     join consultants c on c.id = wg.consultant_id where c.name = 'Ana Paula'`
  )).rows[0].total;
  const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  assert.equal(await ed.$eval('#mgrid tbody tr td.goal', e => e.textContent.replace(/\s/g, ' ')), brl0.format(anaGoalSum).replace(/\s/g, ' '), 'meta do mês de Ana Paula = soma das metas semanais dela (5.000 por semana cadastrada)');
  assert.equal(await fetchAs(ed, '/api/state', { method: 'PUT', body: '{}' }), 403);
  assert.equal(await fetchAs(ed, '/api/users'), 403);
  ok('editor lança valores, não vê Cadastros/Usuários, meta do mês é só leitura e a API recusa o resto');
  await ed.close();

  const vw = await openAs(VW);
  await loaded(vw, 'viewer carregou');
  await vw.click('.tab[data-v=sem]');
  assert.equal(await vw.$$eval('#grid input[data-b^="e:"]', a => a.length > 0 && a.every(i => i.disabled)), true);
  assert.equal(await fetchAs(vw, '/api/entries', { method: 'PATCH', body: JSON.stringify({ cells: [] }) }), 403);
  ok('viewer só consulta: campos travados e a API recusa gravar');
  await vw.close();

  console.log('Conflito');
  // Chrome deixa a aba de trás em segundo plano: alterna com bringToFront() a cada passo.
  const a = await openAs(ADMIN);
  await loaded(a, 'aba a'); await a.click('.tab[data-v=cad]');
  const b = await openAs(ADMIN);
  await loaded(b, 'aba b'); await b.click('.tab[data-v=cad]');
  const NAME = 'input[data-b^="c:"][data-b$=":name"]';
  await a.bringToFront();
  await a.click('[data-act=edit][data-key=cons]');
  const i1 = await a.$(NAME); await i1.focus(); await a.keyboard.down('Control'); await a.keyboard.press('a'); await a.keyboard.up('Control'); await i1.type('Ana A'); await a.keyboard.press('Tab');
  await a.click('[data-act=save-edit][data-key=cons]');
  await saved(a, 'a salvou');
  await b.bringToFront();
  await b.click('[data-act=edit][data-key=cons]');
  const i2 = await b.$(NAME); await i2.focus(); await b.keyboard.down('Control'); await b.keyboard.press('a'); await b.keyboard.up('Control'); await i2.type('Ana B'); await b.keyboard.press('Tab');
  await b.click('[data-act=save-edit][data-key=cons]');
  await until(b, () => /outra pessoa/i.test(document.querySelector('#toast').textContent), 'aviso de conflito');
  assert.equal((await db.query('select name from consultants order by position limit 1')).rows[0].name, 'Ana A');
  await until(b, () => document.querySelector('input[data-b^="c:"][data-b$=":name"]').value === 'Ana A', 'b recarregou');
  ok('dois admins editando ao mesmo tempo: o segundo é avisado e recarrega, sem sobrescrever');
  await a.close(); await b.close();

  assert.deepEqual(errors, []);
  ok('nenhum erro de JavaScript no navegador');
  console.log(`\n${n} verificações passaram.`);
} catch (e) {
  console.error('\nFALHOU:', e.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close(); server.close(); await pg.close();
}
