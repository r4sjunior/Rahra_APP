// Cria (ou atualiza) as tabelas no Neon.  Uso:  DATABASE_URL="postgres://..." npm run db:setup
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Defina DATABASE_URL (a connection string do Neon) antes de rodar.');
  process.exit(1);
}

const sql = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const pool = new Pool({ connectionString: url });
try {
  await pool.query(sql);
  const { rows } = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1"
  );
  console.log('Banco pronto. Tabelas:', rows.map(r => r.table_name).join(', '));
} catch (e) {
  console.error('Falhou:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
