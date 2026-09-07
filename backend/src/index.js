import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import adminRouter from './admin.js';
import authRouter, { requireAuth } from './auth.js';
import dashboardRouter from './dashboard.js';
import projectRouter from './projects.js';
import workspaceRouter from './workspaces.js';
import { pool } from './db.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
// Single proxy hop (Render) so req.ip is the real client for login rate limiting.
app.set('trust proxy', 1);

// Minimal security headers (no extra deps): API serves JSON only, never HTML.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/workspaces', workspaceRouter);
app.use('/api/projects', projectRouter);
app.use('/api/dashboard', dashboardRouter);
// Alias for spec compat: POST /workspaces, GET /workspaces, GET /workspaces/:id
app.use('/workspaces', workspaceRouter);
app.use('/projects', projectRouter);

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.json({ status: 'ok', db: 'down' });
  }
});

app.get('/api/employees', requireAuth, async (_req, res) => {
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

// Central error handler: JSON only, never leak stacks to clients.
app.use((err, _req, res, _next) => {
  const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'internal error' : String(err.message || 'error') });
});

export default app;
export { pool };
