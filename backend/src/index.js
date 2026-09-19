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

// Observable logs (stdout, no extra deps): one line per API request
// (method, path, status, duration, actor) + full stacks for 5xx and any
// process/pool-level failures. Tail with:
//   tail -f /tmp/opencode/backend-public.log /tmp/opencode/backend-admin.log
function logLine(...args) {
  console.log(new Date().toISOString(), ...args);
}
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    const who = req.user?.email || req.user?.id || '-';
    const fullPath = (req.originalUrl || req.path).split('?')[0];
    logLine(`${req.method} ${fullPath} -> ${res.statusCode} (${Date.now() - start}ms) [${who}]`);
  });
  next();
});

// Service split: ADMIN_MODE=public|admin|all (default all).
// - public: employee app. Mounts auth + workspaces + projects + dashboard +
//   /api/employees. /api/admin/* answers 404 so normal users can't even
//   detect the admin API on this port.
// - admin: back-office only. Mounts auth (login/refresh/verify for admin JWE)
//   + /api/admin. Business routes answer 404 here.
// - all (default, used by tests): everything, backwards compatible.
const ADMIN_MODE = (process.env.ADMIN_MODE || 'all').toLowerCase();
const isPublic = ADMIN_MODE === 'public';
const isAdminService = ADMIN_MODE === 'admin';

const notFound = (_req, res) => res.status(404).json({ error: 'not found' });

app.use('/api/auth', authRouter);
if (!isPublic) {
  app.use('/api/admin', adminRouter);
} else {
  app.use('/api/admin', notFound);
}
if (!isAdminService) {
  app.use('/api/workspaces', workspaceRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/dashboard', dashboardRouter);
  // Alias for spec compat: POST /workspaces, GET /workspaces, GET /workspaces/:id
  app.use('/workspaces', workspaceRouter);
  app.use('/projects', projectRouter);
} else {
  app.use('/api/workspaces', notFound);
  app.use('/api/projects', notFound);
  app.use('/api/dashboard', notFound);
  app.use('/workspaces', notFound);
  app.use('/projects', notFound);
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.json({ status: 'ok', db: 'down' });
  }
});

if (!isAdminService) {
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
} else {
  app.get('/api/employees', notFound);
}

const port = Number(
  isAdminService ? process.env.ADMIN_PORT || 4001 : process.env.PORT || 4000
);
// Only listen when executed directly (`node src/index.js`), never when
// imported (e.g. by tests) — otherwise the open server keeps the event
// loop alive and `npm test` hangs forever in CI.
const isDirectRun =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  app.listen(port, () =>
    console.log(`backend (${ADMIN_MODE}) listening on :${port}`)
  );
}

// Central error handler: JSON only, never leak stacks to clients.
// 5xx log with full context (method/path/actor/stack); 4xx already appear
// in the request log, so only the message is logged at debug depth.
app.use((err, req, res, _next) => {
  const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? err.status : 500;
  const fullPath = ((req.originalUrl || req.path) || '').split('?')[0];
  const where = `${req.method} ${fullPath} [${req.user?.email || req.user?.id || '-'}]`;
  if (status >= 500) {
    console.error(new Date().toISOString(), `ERROR ${where} -> ${status}:`, err?.stack || err);
  } else {
    console.error(new Date().toISOString(), `ERROR ${where} -> ${status}: ${err?.message || 'error'}`);
  }
  res.status(status).json({ error: status === 500 ? 'internal error' : String(err.message || 'error') });
});

// Failures outside any request (idle DB clients, promise bugs): log loudly
// so `grep ERROR` finds them instead of failing silently.
pool.on('error', (err) => {
  console.error(new Date().toISOString(), 'ERROR [pg-pool] idle client:', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error(new Date().toISOString(), 'ERROR [unhandledRejection]:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error(new Date().toISOString(), 'ERROR [uncaughtException]:', err?.stack || err);
});

export default app;
export { pool };
