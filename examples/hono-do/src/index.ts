import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuth } from './auth';
import type { CloudflareBindings } from './env';

// REQUIRED: re-export the DO classes so Cloudflare can register them.
// The `class_name` entries in wrangler.toml reference these symbols.
export { UserDurableObject, IdentityDurableObject } from 'better-auth-cloudflare';

type Variables = { auth: ReturnType<typeof createAuth> };

const app = new Hono<{ Bindings: CloudflareBindings; Variables: Variables }>();

app.use(
  '/api/auth/**',
  cors({
    origin: (origin) => origin ?? '*',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    credentials: true,
  }),
);

app.use('*', async (c, next) => {
  const cf = (c.req.raw as unknown as { cf?: unknown }).cf ?? {};
  const auth = createAuth(c.env, cf as Parameters<typeof createAuth>[1], new URL(c.req.url).origin);
  c.set('auth', auth);
  await next();
});

app.all('/api/auth/*', async (c) => c.get('auth').handler(c.req.raw));

app.get('/protected', async (c) => {
  const session = await c.get('auth').api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ ok: false, reason: 'unauthenticated' }, 401);
  return c.json({
    ok: true,
    userId: session.user.id,
    sessionId: session.session.id,
    isAnonymous: (session.user as { isAnonymous?: boolean }).isAnonymous ?? false,
    storedIn: 'durable-object',
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/', (c) => c.html(HOME_PAGE));

export default app;

const HOME_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>better-auth-cloudflare DO demo (Hono)</title>
  <style>
    body { font-family: system-ui; max-width: 640px; margin: 0 auto; padding: 24px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin: 16px 0; }
    button { padding: 8px 16px; margin: 6px 4px; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer; background: white; }
    .primary { background: #2563eb; color: white; border-color: #2563eb; }
    input { padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; width: 100%; box-sizing: border-box; margin: 4px 0; }
    label { display: block; margin: 8px 0 2px; font-weight: 500; }
    .info-row { margin: 8px 0; }
    .info-row .label { display: inline-block; width: 130px; font-weight: 600; }
    pre { background: #f3f4f6; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #dbeafe; color: #1e40af; font-size: 0.75rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>better-auth-cloudflare DO demo (Hono)</h1>
    <p class="badge">Storage: Durable Objects (no D1, no Hyperdrive)</p>

    <div id="status">Loading…</div>

    <div id="not-logged-in" style="display:none;">
      <button id="btn-anon" class="primary">Continue as guest</button>
      <details><summary style="cursor:pointer; margin:12px 0;">Sign up with email</summary>
        <form id="form-signup">
          <label>Email <input id="su-email" type="email" required></label>
          <label>Password <input id="su-pass" type="password" required minlength="8"></label>
          <button type="submit" class="primary">Create account</button>
        </form>
      </details>
      <details><summary style="cursor:pointer; margin:12px 0;">Sign in</summary>
        <form id="form-signin">
          <label>Email <input id="si-email" type="email" required></label>
          <label>Password <input id="si-pass" type="password" required></label>
          <button type="submit" class="primary">Sign in</button>
        </form>
      </details>
    </div>

    <div id="logged-in" style="display:none;">
      <p>Welcome, <span id="user-name" style="font-weight:600;"></span>.</p>
      <div id="user-info"></div>
      <div id="geo-info"></div>
      <div style="margin-top:16px;">
        <button id="btn-protected" class="primary">Try protected route</button>
        <button id="btn-signout">Sign out</button>
      </div>
    </div>

    <div id="protected-result"></div>
  </div>

  <script>
    function $(id) { return document.getElementById(id); }
    let currentUser = null;
    function row(parent, label, value) {
      const d = document.createElement('div'); d.className = 'info-row';
      const l = document.createElement('span'); l.className = 'label'; l.textContent = label + ':'; d.appendChild(l);
      const v = document.createElement('span'); v.textContent = value ?? '(unknown)'; d.appendChild(v);
      parent.appendChild(d);
    }
    async function check() {
      const r = await fetch('/api/auth/get-session', { credentials: 'include' });
      if (r.ok) { const d = await r.json(); if (d && d.user) { currentUser = d.user; return show(); } }
      $('status').textContent = 'Status: signed out';
      $('not-logged-in').style.display = 'block';
      $('logged-in').style.display = 'none';
    }
    async function show() {
      $('status').textContent = 'Status: signed in';
      $('not-logged-in').style.display = 'none';
      $('logged-in').style.display = 'block';
      $('user-name').textContent = currentUser.name || currentUser.email || 'guest';
      const ui = $('user-info'); ui.textContent = '';
      row(ui, 'Email', currentUser.email || '(anonymous)');
      row(ui, 'User ID', currentUser.id);
      row(ui, 'Anonymous', currentUser.isAnonymous ? 'yes' : 'no');
      try {
        const gr = await fetch('/api/auth/cloudflare/geolocation', { credentials: 'include' });
        if (gr.ok) {
          const g = await gr.json(); const gi = $('geo-info'); gi.textContent = '';
          row(gi, 'Country', g.country); row(gi, 'Region', g.region);
          row(gi, 'City', g.city); row(gi, 'Data center', g.colo);
        }
      } catch {}
    }
    async function api(path, body) {
      const r = await fetch(path, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!r.ok) throw new Error(path + ' failed: ' + r.status);
      return r;
    }
    document.addEventListener('DOMContentLoaded', () => {
      $('btn-anon').addEventListener('click', async () => { await api('/api/auth/sign-in/anonymous'); check(); });
      $('form-signup').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('/api/auth/sign-up/email', { email: $('su-email').value, password: $('su-pass').value, name: $('su-email').value.split('@')[0] }); check(); }
        catch (err) { alert(err.message); }
      });
      $('form-signin').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('/api/auth/sign-in/email', { email: $('si-email').value, password: $('si-pass').value }); check(); }
        catch (err) { alert(err.message); }
      });
      $('btn-protected').addEventListener('click', async () => {
        const r = await fetch('/protected', { credentials: 'include' });
        const d = await r.json(); const c = $('protected-result'); c.textContent = '';
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(d, null, 2); c.appendChild(pre);
      });
      $('btn-signout').addEventListener('click', async () => { await api('/api/auth/sign-out'); currentUser = null; check(); $('protected-result').textContent = ''; });
      check();
    });
  </script>
</body>
</html>`;
