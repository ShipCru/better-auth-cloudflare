import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import type { CloudflareBindings } from "./env";

// REQUIRED: re-export the DO classes so Cloudflare can register them.
// The `class_name` entries in wrangler.toml reference these symbols.
export { UserDurableObject, IdentityDurableObject } from "better-auth-cloudflare";

type Variables = { auth: ReturnType<typeof createAuth> };

const app = new Hono<{ Bindings: CloudflareBindings; Variables: Variables }>();

// Note on compression: Cloudflare's edge automatically compresses responses
// based on the client's Accept-Encoding header (brotli > gzip). We do NOT
// run server-side compression here — Hono's compress() would compress
// unconditionally and break clients that don't advertise Accept-Encoding.

// Cache headers per route family. Cloudflare honors these at the edge.
//   /api/auth/*  → no-store (auth state must never be cached)
//   /admin/*     → private, max-age=10 (~aligns with the recovery sync window)
app.use("/api/auth/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "private, no-store, max-age=0");
});
app.use("/admin/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "private, max-age=10");
});

app.use(
    "/api/auth/**",
    cors({
        origin: origin => origin ?? "*",
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["POST", "GET", "OPTIONS"],
        credentials: true,
    })
);

app.use("*", async (c, next) => {
    const cf = (c.req.raw as unknown as { cf?: unknown }).cf ?? {};
    const auth = createAuth(c.env, cf as Parameters<typeof createAuth>[1], new URL(c.req.url).origin);
    c.set("auth", auth);
    await next();
});

app.all("/api/auth/*", async c => c.get("auth").handler(c.req.raw));

app.get("/protected", async c => {
    const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ ok: false, reason: "unauthenticated" }, 401);
    return c.json({
        ok: true,
        userId: session.user.id,
        sessionId: session.session.id,
        isAnonymous: (session.user as { isAnonymous?: boolean }).isAnonymous ?? false,
        storedIn: "durable-object",
    });
});

app.get("/health", c => c.json({ status: "ok" }));

/**
 * Debug-only metrics endpoint. Returns the analytics dataset binding
 * status plus a sample SQL query for the Cloudflare Analytics Engine
 * API. AE doesn't expose a runtime SQL API from inside Workers — queries
 * must go through the account-level GraphQL/SQL API. Gate this behind
 * admin auth + IP allowlist for production.
 */
app.get("/debug/metrics", async c => {
    const ae = c.env.AUTH_ANALYTICS;
    if (!ae) {
        return c.json(
            {
                error: "AUTH_ANALYTICS not bound",
                note: "Bind an Analytics Engine dataset in wrangler.toml to enable.",
            },
            503
        );
    }
    return c.json({
        bindingPresent: true,
        sampleQuery: `
            SELECT blob1 AS operation,
                   quantileExact(0.50)(double1) AS p50_ms,
                   quantileExact(0.95)(double1) AS p95_ms,
                   quantileExact(0.99)(double1) AS p99_ms,
                   count() AS n
            FROM ba_cf_do_events
            WHERE timestamp > NOW() - INTERVAL '1' HOUR
              AND double2 = 1
            GROUP BY blob1
            ORDER BY n DESC
        `.trim(),
        runVia: "https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql",
    });
});

/**
 * Admin/dashboard read endpoint. Reads users straight from the D1 recovery
 * store. This is the "dashboard" use case: D1 is kept in sync by the
 * UserDO outbox + alarm + waitUntil, so queries here are at most ~10s
 * behind live DO state.
 *
 * Demonstrates the read pattern. NOT protected here — wrap in your own
 * admin auth for production. (BA itself has no built-in admin role; check
 * `session.user.email` against an allow-list or use a separate admin token.)
 */
app.get("/admin/users", async c => {
    const db = c.env.AUTH_DB;
    if (!db) return c.json({ error: "AUTH_DB not bound" }, 503);

    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const result = await db
        .prepare(
            `SELECT id, name, email, email_verified, is_anonymous, created_at, updated_at
               FROM users
               WHERE deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`
        )
        .bind(limit, offset)
        .all();

    const total = (await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL`).first()) as {
        c: number;
    } | null;

    return c.json({
        users: result.results,
        pagination: { limit, offset, total: total?.c ?? 0 },
    });
});

/** Same but for accounts — shows which providers each user has linked. */
app.get("/admin/accounts", async c => {
    const db = c.env.AUTH_DB;
    if (!db) return c.json({ error: "AUTH_DB not bound" }, 503);
    const userId = c.req.query("userId");
    if (!userId) return c.json({ error: "userId query param required" }, 400);
    const result = await db
        .prepare(`SELECT id, provider_id, account_id, created_at FROM accounts WHERE user_id = ?`)
        .bind(userId)
        .all();
    return c.json({ accounts: result.results });
});

/**
 * Dev-only metadata endpoint. Surfaces the Cloudflare request region (where
 * the user hit the edge), the resolved principal id (= DO name for this
 * principal), and bindings available at the Worker. Useful for debugging
 * routing, residency, and for the active-DO dashboard. Safe to leave on in
 * production.
 *
 * Note: a DO's own physical colo is not directly introspectable from inside
 * the DO. Use Cloudflare's namespace metrics dashboard for placement. The
 * request colo + principalId together are enough to correlate traffic with
 * DO instances in your logs.
 */
app.get("/debug/region", async c => {
    const cf = (c.req.raw as unknown as { cf?: Record<string, unknown> }).cf ?? {};
    const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
    const principalId = session?.user?.id ?? null;
    return c.json({
        request: {
            colo: cf.colo ?? null,
            country: cf.country ?? null,
            continent: cf.continent ?? null,
            region: cf.region ?? null,
            regionCode: cf.regionCode ?? null,
            city: cf.city ?? null,
            timezone: cf.timezone ?? null,
            latitude: cf.latitude ?? null,
            longitude: cf.longitude ?? null,
        },
        principal: principalId
            ? {
                  id: principalId,
                  doNamespace: "USER_DO",
                  doName: principalId,
                  isAnonymous: (session?.user as { isAnonymous?: boolean })?.isAnonymous ?? false,
              }
            : null,
    });
});

app.get("/", c => c.html(HOME_PAGE));

export default app;

const HOME_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>better-auth-cloudflare DO demo (Hono)</title>
  <style>
    body { font-family: system-ui; max-width: 640px; margin: 0 auto; padding: 24px; }
    @keyframes spin { to { transform: rotate(360deg); } }
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

    <div id="op-meter" style="display:none; padding:8px 12px; margin:12px 0; border-radius:6px; background:#fef3c7; color:#92400e; font-size:0.85rem;">
      <span id="op-label">…</span>
      <span id="op-spinner" style="display:inline-block; width:10px; height:10px; border:2px solid #92400e; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-left:6px; vertical-align:middle;"></span>
      <span id="op-timing" style="margin-left:12px; color:#1f2937; display:none;"></span>
    </div>

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
          <a href="#" id="btn-forgot" style="display:inline-block; margin-left:8px; font-size:0.85rem;">Forgot password?</a>
        </form>
      </details>
      <details><summary style="cursor:pointer; margin:12px 0;">Sign in with Google</summary>
        <p style="font-size:0.85rem; color:#6b7280; margin:8px 0;">
          Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to be set on the Worker.
        </p>
        <button id="btn-google" class="primary">Continue with Google</button>
      </details>
    </div>

    <div id="forgot-result" style="display:none; margin-top:12px; padding:10px; border-radius:4px; background:#dcfce7; color:#166534; font-size:0.9rem;"></div>

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

    <details style="margin-top: 24px;">
      <summary style="cursor: pointer; font-size: 0.9rem; color: #6b7280;">Dev metadata (request region + DO)</summary>
      <div id="debug-region" style="margin-top: 12px;">
        <button id="btn-refresh-debug" style="font-size: 0.85rem;">Refresh</button>
        <pre id="debug-region-pre" style="margin-top: 8px;">click Refresh</pre>
      </div>
    </details>
  </div>

  <script>
    function $(id) { return document.getElementById(id); }
    let currentUser = null;

    // Wraps an async fn with: visible op label, spinner during, response
    // time after. Errors are surfaced in the meter and re-thrown.
    async function timed(label, fn) {
      const meter = $('op-meter');
      const lab = $('op-label');
      const spin = $('op-spinner');
      const tim = $('op-timing');
      meter.style.display = 'block';
      meter.style.background = '#fef3c7';
      meter.style.color = '#92400e';
      lab.textContent = label + '…';
      spin.style.display = 'inline-block';
      tim.style.display = 'none';
      const t0 = performance.now();
      try {
        const r = await fn();
        const ms = Math.round(performance.now() - t0);
        lab.textContent = label + ' ✓';
        meter.style.background = '#dcfce7';
        meter.style.color = '#166534';
        spin.style.display = 'none';
        tim.textContent = ms + ' ms';
        tim.style.display = 'inline';
        return r;
      } catch (err) {
        const ms = Math.round(performance.now() - t0);
        lab.textContent = label + ' ✗ ' + (err && err.message ? err.message : 'error');
        meter.style.background = '#fee2e2';
        meter.style.color = '#991b1b';
        spin.style.display = 'none';
        tim.textContent = ms + ' ms';
        tim.style.display = 'inline';
        throw err;
      }
    }

    function row(parent, label, value) {
      const d = document.createElement('div'); d.className = 'info-row';
      const l = document.createElement('span'); l.className = 'label'; l.textContent = label + ':'; d.appendChild(l);
      const v = document.createElement('span'); v.textContent = value ?? '(unknown)'; d.appendChild(v);
      parent.appendChild(d);
    }
    async function check() {
      const r = await timed('get-session', () => fetch('/api/auth/get-session', { credentials: 'include' }));
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
      return timed(path, async () => {
        const r = await fetch(path, { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(path + ' failed: ' + r.status + (text ? ' — ' + text.slice(0, 80) : ''));
        }
        return r;
      });
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
        const r = await timed('/protected', () => fetch('/protected', { credentials: 'include' }));
        const d = await r.json(); const c = $('protected-result'); c.textContent = '';
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(d, null, 2); c.appendChild(pre);
      });
      $('btn-signout').addEventListener('click', async () => { await api('/api/auth/sign-out'); currentUser = null; check(); $('protected-result').textContent = ''; });
      $('btn-forgot').addEventListener('click', async (ev) => {
        ev.preventDefault();
        const email = $('si-email').value || prompt('Email to send reset link to:');
        if (!email) return;
        try {
          await api('/api/auth/forget-password', { email, redirectTo: window.location.origin + '/' });
          const box = $('forgot-result');
          box.textContent = 'Password reset link sent. Check the Worker logs (in dev) or your email (in prod) for the reset URL.';
          box.style.display = 'block';
        } catch (err) { alert(err.message); }
      });
      $('btn-google').addEventListener('click', async () => {
        try {
          const r = await api('/api/auth/sign-in/social', { provider: 'google', callbackURL: '/' });
          const data = await r.json();
          if (data.url) window.location.href = data.url;
        } catch (err) {
          alert('Google sign-in not configured. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.\\n\\n' + err.message);
        }
      });
      $('btn-refresh-debug').addEventListener('click', async () => {
        const r = await timed('/debug/region', () => fetch('/debug/region', { credentials: 'include' }));
        const d = await r.json();
        $('debug-region-pre').textContent = JSON.stringify(d, null, 2);
      });
      check();
    });
  </script>
</body>
</html>`;
