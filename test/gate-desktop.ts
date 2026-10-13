// Desktop mode gate: a web page on another site can't reach Forge, only the launch key signs in, and Forge listens on this PC only.
// Usage: FORGE_URL=http://127.0.0.1:3300 FORGE_LAUNCH_KEY=… node test/gate-desktop.ts
// Needs Forge started with FORGE_MODE=desktop and the same FORGE_LAUNCH_KEY. Uses no Claude turns.

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { BASE } from './config.ts';

const KEY = process.env.FORGE_LAUNCH_KEY ?? '';
const url = new URL(BASE);
const PORT = Number(url.port);
type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

/** A raw request, so the Host and Origin headers are exactly what a browser on a hostile page would send. */
function request(method: string, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: PORT, method, path: pathname, headers: { host: url.host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** How a WebSocket connection ends: 'open' if it stays up, else the close code. */
function wsResult(headers: Record<string, string>, origin?: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, { headers, ...(origin && { origin }) });
    const timer = setTimeout(() => (ws.close(), resolve('open')), 1500);
    ws.on('close', (code) => (clearTimeout(timer), resolve(String(code))));
    ws.on('error', () => {});
  });
}

try {
  if (KEY.length < 24) throw new Error('Set FORGE_LAUNCH_KEY to the key Forge was started with.');

  const authInfo = JSON.parse((await request('GET', '/api/auth')).body);
  check('Forge says it is in desktop mode', authInfo.mode === 'desktop', authInfo);

  const rebind = await request('GET', '/api/auth', { host: `evil.example:${PORT}` });
  check('a request addressed to another site name is refused (DNS rebinding)', rebind.status === 403, rebind.status);

  const wrong = await request('GET', `/launch?key=${'x'.repeat(KEY.length)}`);
  check('a wrong launch key is refused', wrong.status === 403, wrong.status);

  const launch = await request('GET', `/launch?key=${encodeURIComponent(KEY)}`);
  const cookie = String(launch.headers['set-cookie'] ?? '').split(';')[0];
  check('the launch key signs in, with a SameSite=Strict cookie', launch.status === 302 && /SameSite=Strict/.test(String(launch.headers['set-cookie'])), launch.headers['set-cookie']);

  const withCookie = await request('GET', '/api/projects', { cookie });
  check('that cookie opens the API', withCookie.status === 200, withCookie.status);

  const crossSite = await request('GET', '/api/projects', { cookie, origin: 'http://evil.example' });
  check('a request from another site is refused, even carrying the cookie', crossSite.status === 403, crossSite.status);

  const noCookie = await request('GET', '/api/projects');
  check('without signing in, the API is closed', noCookie.status === 401, noCookie.status);

  const login = await request('POST', '/api/login', { 'content-type': 'application/json' });
  check('there is no password sign-in in desktop mode', login.status >= 400 && !login.headers['set-cookie'], login.status);

  check('a WebSocket from another site is closed, even carrying the cookie', (await wsResult({ cookie }, 'http://evil.example')) === '4403');
  check('a WebSocket without signing in is closed', (await wsResult({}, BASE)) === '4401');
  check('a WebSocket from Forge’s own page with the cookie stays open', (await wsResult({ cookie }, BASE)) === 'open');

  // Listening on this PC only: Forge must not answer on the PC's network address.
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (lan) {
    const reachable = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: lan, port: PORT, timeout: 1500 }, () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
      s.on('timeout', () => (s.destroy(), resolve(false)));
    });
    check(`Forge doesn't answer on the network address (${lan})`, !reachable);
  }

  // Opening a folder from elsewhere on this PC as a project, then taking it off the list.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-'));
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, { headers: { cookie }, origin: BASE });
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((r) => ws.on('open', r));
  const waitFor = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 50; i++) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  ws.send(JSON.stringify({ type: 'projectOpenFolder', path: dir }));
  const opened = await waitFor((m) => m.type === 'projectResult');
  const listed = await waitFor((m) => m.type === 'projects' && m.projects.some((p: any) => p.opened === dir));
  check('a folder elsewhere on this PC opens as a project', opened?.ok === true && !!listed, opened);
  messages.length = 0;
  ws.send(JSON.stringify({ type: 'projectForget', name: opened?.name }));
  const gone = await waitFor((m) => m.type === 'projects' && !m.projects.some((p: any) => p.opened === dir));
  check('it comes off the list, and its folder stays', !!gone && fs.existsSync(dir));
  ws.close();
  fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
  check('gate ran to the end', false, String(err));
}
const failed = checks.filter((x) => !x.pass);
console.log(`\nGate desktop: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
