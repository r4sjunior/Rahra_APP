// Conexão com o Neon (Postgres). Interface mínima usada por lib/core.js:
//   db.query(text, params) -> { rows, rowCount }
//   db.tx(async q => ...)  -> roda tudo numa transação (q tem a mesma forma de db.query)
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

let pool;
export function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL });
  return {
    query: (text, params) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn((t, p) => client.query(t, p));
        await client.query('commit');
        return out;
      } catch (e) {
        try { await client.query('rollback'); } catch {}
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
