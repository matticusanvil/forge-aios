// Phase 6 gate: everything that runs code sits behind the shared password, deploys are healthy, and the UI is built
// from the design system's tokens. Usage: node test/gate-phase6.ts [http://host:3200]
// The password, lockout and cookie logic is exercised on a throwaway copy of the auth store (not the live one).

import fs from 'node:fs';
import { BASE } from './config.ts';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Auth } from '../server/auth.ts';
import { authHeaders } from './client.ts';

type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

/** How a WebSocket attempt ends: opened (with the first message) or closed with a code. */
function tryWs(headers: Record<string, string>): Promise<{ opened: boolean; code?: number; first?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, { headers });
    ws.on('message', (m) => {
      resolve({ opened: true, first: JSON.parse(String(m)).type });
      ws.close();
    });
    ws.on('close', (code) => resolve({ opened: false, code }));
    ws.on('error', () => resolve({ opened: false }));
  });
}

try {
  // 1. Locked down without a sign-in.
  const projects = await fetch(`${BASE}/api/projects`);
  check('the API refuses requests without a sign-in', projects.status === 401, projects.status);
  const anon = await tryWs({});
  check('the live socket refuses browsers without a sign-in', !anon.opened && anon.code === 4401, anon);
  const wrong = await tryWs({ authorization: 'Bearer not-the-token-not-the-token-xx' });
  check('a wrong API token is refused', !wrong.opened && wrong.code === 4401, wrong);
  const page = await fetch(`${BASE}/`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('the page and health check stay public (no data in them)', page.ok && health.ok === true, health);
  const phone = await fetch(`${BASE}/api/approvals/nope/decide?d=allow&t=x`, { method: 'POST' });
  check('phone buttons still work without a sign-in (single-use tokens)', phone.status === 410, phone.status);
  const hook = await fetch(`${BASE}/hooks/playground/PreToolUse`, { method: 'POST', body: '{}' });
  check('hooks still refuse callers from the network', hook.status === 403, hook.status);

  // 2. With the API token.
  const ok = await fetch(`${BASE}/api/projects`, { headers: authHeaders() });
  const authed = await tryWs(authHeaders());
  check('with the token, the API and the socket open', ok.ok && authed.opened && authed.first === 'hello', { status: ok.status, ws: authed });

  // 3. The password logic, on a throwaway store.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-'));
  const auth = new Auth(dir, undefined);
  const code = auth.setupCode!;
  check('before a password exists there is a setup code', !auth.passwordSet && /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(code), code.replace(/./g, '*'));
  check('setting it needs the right setup code', auth.setPassword('long enough password', 'WRONG-CODE0', 'ip1') !== null);
  check('a short password is refused', auth.setPassword('short', code, 'ip1') !== null);
  check('the right setup code sets it', auth.setPassword('long enough password', code, 'ip1') === null && auth.passwordSet);
  const stored = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  check('only a hash is stored', !stored.includes('long enough password') && /"hash"/.test(stored));
  check('the right password signs in', auth.check('ip2', 'long enough password') === true);
  const results = Array.from({ length: 6 }, () => auth.check('ip3', 'guess'));
  check('after 5 wrong passwords that address must wait', results.slice(0, 5).every((r) => r === false) && results[5] === null, results);
  check('…even with the right one, until the wait ends', auth.check('ip3', 'long enough password') === null);
  check('other addresses are unaffected', auth.check('ip4', 'long enough password') === true);
  const headers = new Map<string, string>();
  auth.signIn({ setHeader: (k: string, v: string) => headers.set(k, v) } as any);
  const cookie = headers.get('Set-Cookie')!;
  const req = (c: string) => ({ headers: { cookie: c } }) as any;
  check('a sign-in cookie is HttpOnly and lasts 30 days', /HttpOnly/.test(cookie) && /Max-Age=2592000/.test(cookie));
  check('the cookie is accepted; a made-up one is not', auth.allowed(req(cookie.split(';')[0])) && !auth.allowed(req('forge_session=made-up')));
  auth.setPassword('another long password', 'long enough password', 'ip5');
  check('changing the password signs every browser out', !auth.allowed(req(cookie.split(';')[0])));
  fs.rmSync(dir, { recursive: true, force: true });

  // 4. Built from the design system's tokens.
  const html = await page.text();
  const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  const sheet = css ? await fetch(`${BASE}${css}`).then((r) => r.text()) : '';
  const tokens = ['--anvil-gold: #fdbe16', '--anvil-black: #000000', '--agent-teal: #5fd4c2', '--status-waiting: #ff8904', '--radius-elbow: 48px'];
  check('the UI ships the design system tokens', tokens.every((t) => sheet.includes(t)), tokens.filter((t) => !sheet.includes(t)));
  check('…and its components (frame, chat, approvals, subagents, timeline, sign-in)', ['.fa-frame__elbow', '.fa-chat', '.fa-approval', '.fa-sub', '.fa-lane', '.fa-auth'].every((c) => sheet.includes(c)));
} catch (err) {
  check('gate ran to the end', false, String(err));
}
const failed = checks.filter((x) => !x.pass);
console.log(`\nGate phase 6: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
