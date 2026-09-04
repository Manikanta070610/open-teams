import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src -> repo root is two levels up
const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [
  'db/01_core.sql',
  'db/02_projects.sql',
  'db/03_hr.sql',
  'db/04_collab_chat.sql',
  'db/05_triggers.sql',
  'db/06_indexes.sql',
  'db/07_seed.sql',
  'db/08_dept_governance.sql',
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const f of FILES) {
    const sql = await readFile(path.join(ROOT, f), 'utf8');
    console.log(`applying ${f}...`);
    await client.query(sql);
  }
  console.log('migrate: done');
} finally {
  await client.end();
}
