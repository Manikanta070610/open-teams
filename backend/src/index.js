import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'office_mgmt_final',
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.json({ status: 'ok', db: 'down' });
  }
});

app.get('/api/employees', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, first_name, last_name, email, rank FROM employees WHERE is_active = TRUE ORDER BY id LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const port = Number(process.env.PORT || 4000);
// Only listen when executed directly (`node src/index.js`), never when
// imported (e.g. by tests) — otherwise the open server keeps the event
// loop alive and `npm test` hangs forever in CI.
const isDirectRun =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  app.listen(port, () => console.log(`backend listening on :${port}`));
}

export default app;
