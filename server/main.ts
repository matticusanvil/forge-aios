import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Auth } from './auth.ts';
import { commitIdentity } from './git.ts';
import { Notifier, notifyConfigFromEnv } from './notify.ts';
import { CLAUDE, DATA_DIR, DEFAULT_PROJECT, LAUNCH_KEY, MODE } from './config.ts';
import { Project, type ClientMessage, type Globals, type ProjectSummary } from './project.ts';
import { Wikis } from './wikis.ts';

const run = promisify(execFile);

const PORT = Number(process.env.PORT ?? 3200);
// The project a new browser (or test) lands on; every folder beside it is a project too.
const DEFAULT_DIR = DEFAULT_PROJECT;
const REPOS = process.env.FORGE_REPOS ?? path.dirname(DEFAULT_DIR);
const DATA = DATA_DIR;
try {
  fs.mkdirSync(REPOS, { recursive: true });
} catch (err) {
  console.error(`Forge AIOS can't use ${REPOS} as its projects folder: ${(err as Error).message}. Set FORGE_PROJECT to a folder you can write to.`);
  process.exit(1);
}
// Normally empty: the PreToolUse hook decides every call. Kept for tests that need a fixed allowlist.
const ALLOWED_TOOLS = process.env.FORGE_ALLOWED_TOOLS ? process.env.FORGE_ALLOWED_TOOLS.split(',') : [];
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC = path.join(ROOT, 'web/dist');
// Context wikis live beside the projects, in a hidden folder the project list skips.
const WIKIS = process.env.FORGE_WIKIS ?? path.join(REPOS, '.wikis');

const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

// Only the CLIs in this container may call the hook endpoints: loopback plus a per-process secret.
const hookToken = randomBytes(24).toString('hex');

// Everything else needs the shared password (or, for scripts and tests, the API token).
const auth = new Auth(DATA, process.env.FORGE_API_TOKEN);
if (MODE === 'desktop' && LAUNCH_KEY.length < 24) {
  console.error('Desktop mode needs FORGE_LAUNCH_KEY (24 or more characters); the Forge AIOS app sets it.');
  process.exit(1);
}
if (MODE === 'server' && auth.setupCode) console.log(`Forge AIOS has no password yet. Open it in a browser and use this setup code to set one: ${auth.setupCode}`);

/** Account-wide state: how the CLI is logged in, and plan usage (from any project's stream). */
const account = { login: null as { loggedIn: boolean; method: string; plan: string | null } | null, rateLimits: null as unknown };

const globals: Globals = {
  dataDir: DATA,
  hookBase: `http://127.0.0.1:${PORT}/hooks`,
  hookToken,
  allowedTools: ALLOWED_TOOLS,
  notifier: new Notifier(notifyConfigFromEnv(process.env), (message) => console.error(message)),
  wikis: new Wikis(WIKIS),
  account: () => account,
  setRateLimits: (r) => {
    account.rateLimits = r;
    for (const p of projects.values()) p.broadcastSession();
  },
};

globals.wikis.on('removed', (id: string) => {
  for (const p of projects.values()) p.unlinkWiki(id);
});

// How the CLI is logged in, so silent API billing is visible (plan: Risks).
execFile(CLAUDE, ['auth', 'status'], { env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' } }, (_err, stdout) => {
  try {
    const s = JSON.parse(stdout);
    account.login = { loggedIn: !!s.loggedIn, method: String(s.authMethod ?? 'none'), plan: s.subscriptionType ?? null };
  } catch {
    account.login = { loggedIn: false, method: 'unknown', plan: null };
  }
  for (const p of projects.values()) p.broadcastSession();
});

// ---------- projects ----------

/** Every folder in the repos directory is a project, except hidden ones (like the wikis folder). */
/** Folders opened from elsewhere on this PC (name → full path), beside the ones in the projects folder. */
const OPENED = path.join(DATA, 'projects.json');
function openedFolders(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(OPENED, 'utf8'));
  } catch {
    return {};
  }
}

function projectNames(): string[] {
  let inFolder: string[] = [];
  try {
    inFolder = fs.readdirSync(REPOS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && NAME.test(e.name))
      .map((e) => e.name);
  } catch {}
  const opened = Object.entries(openedFolders()).filter(([, dir]) => fs.existsSync(dir)).map(([name]) => name);
  return [...new Set([...inFolder, ...opened])].sort((a, b) => a.localeCompare(b));
}

/** Where a project lives: an opened folder, or its folder in the projects folder. */
const projectDir = (name: string) => openedFolders()[name] ?? path.join(REPOS, name);

/** Adds a folder from elsewhere on this PC as a project, named after the folder. The folder itself isn't changed. */
async function openFolder(dir: string): Promise<string> {
  if (!path.isAbsolute(dir)) throw new Error('Give the full path of the folder.');
  const full = path.resolve(dir);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error(`There's no folder at ${full}.`);
  const opened = openedFolders();
  const already = projectNames().find((n) => path.resolve(projectDir(n)) === full);
  if (already) return already;
  const base = path.basename(full).replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'project';
  let name = base;
  for (let i = 2; projectNames().includes(name); i++) name = `${base}-${i}`;
  fs.writeFileSync(OPENED, JSON.stringify({ ...opened, [name]: full }, null, 2));
  return name;
}

/** Takes an opened folder off the list. Its files and Forge's history for it stay. */
function forgetFolder(name: string): void {
  const { [name]: _gone, ...rest } = openedFolders();
  fs.writeFileSync(OPENED, JSON.stringify(rest, null, 2));
}

const projects = new Map<string, Project>();
/** Which project each browser is watching. */
const clients = new Map<WebSocket, string>();

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** A project, loaded on first use; null if there's no such folder. */
function project(name: string): Project | null {
  const loaded = projects.get(name);
  if (loaded) return loaded;
  if (!NAME.test(name) || !projectNames().includes(name)) return null;
  const p = new Project(name, projectDir(name), globals);
  p.on('message', (msg: object) => {
    const text = JSON.stringify(msg);
    for (const [ws, watching] of clients) if (watching === name && ws.readyState === ws.OPEN) ws.send(text);
  });
  p.on('summary', broadcastProjects);
  p.on('summary', stopEmulatorWhenIdle);
  projects.set(name, p);
  return p;
}

function summaries(): ProjectSummary[] {
  const opened = openedFolders();
  return projectNames().map((name) => ({
    ...(projects.get(name)?.summary() ?? { name, live: false, busy: false, waiting: 0, running: 0, sessionName: null }),
    ...(opened[name] && { opened: opened[name] }),
  }));
}

let anyLive = false;
/** The Android emulator (android-emulator) is stopped once every project's session has parked or ended. */
function stopEmulatorWhenIdle(): void {
  const live = [...projects.values()].some((p) => p.summary().live);
  if (anyLive && !live) execFile('android-emulator', ['stop'], () => {});
  anyLive = live;
}

let projectsTimer: NodeJS.Timeout | null = null;
/** The sidebar's project list, to every browser; coalesced, since status changes come in bursts. */
function broadcastProjects(): void {
  if (projectsTimer) return;
  projectsTimer = setTimeout(() => {
    projectsTimer = null;
    const msg = { type: 'projects', projects: summaries() };
    for (const ws of clients.keys()) send(ws, msg);
  }, 150);
}

const defaultProject = () => (projectNames().includes(path.basename(DEFAULT_DIR)) ? path.basename(DEFAULT_DIR) : projectNames()[0]);

/** Clones a GitHub repo ("owner/name") into the repos folder as a new project. */
async function cloneProject(repo: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Give the repo as owner/name, e.g. your-name/your-repo.');
  const name = repo.split('/')[1].replace(/\.git$/, '');
  if (!NAME.test(name)) throw new Error(`"${name}" can't be a project folder name.`);
  if (fs.existsSync(path.join(REPOS, name))) throw new Error(`There's already a project called ${name}.`);
  await run('git', ['clone', '--quiet', `https://github.com/${repo}.git`, path.join(REPOS, name)], { timeout: 600_000 });
  return name;
}

/** A new empty project: a folder with a git repo and a README. */
async function createProject(name: string): Promise<string> {
  if (!NAME.test(name)) throw new Error('Use letters, digits, dots, dashes and underscores, starting with a letter or digit.');
  const dir = path.join(REPOS, name);
  if (fs.existsSync(dir)) throw new Error(`There's already a project called ${name}.`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  await run('git', ['-C', dir, 'init', '--quiet', '-b', 'main']);
  await run('git', ['-C', dir, 'add', '-A']);
  await run('git', ['-C', dir, ...(await commitIdentity(dir)), 'commit', '--quiet', '-m', 'Start project']);
  return name;
}

type ServerOnlyMessage =
  | { type: 'open'; project: string }
  | { type: 'projectClone'; repo: string }
  | { type: 'projectCreate'; name: string }
  | { type: 'projectOpenFolder'; path: string }
  | { type: 'projectForget'; name: string };

function onClient(ws: WebSocket, msg: ClientMessage | ServerOnlyMessage): void {
  switch (msg.type) {
    case 'open': {
      const p = project(String(msg.project));
      if (!p) return send(ws, { type: 'error', error: `No project called ${msg.project}.` });
      clients.set(ws, p.name);
      send(ws, p.hello());
      send(ws, { type: 'projects', projects: summaries() });
      return;
    }
    case 'projectForget': {
      const name = String(msg.name);
      if (!(name in openedFolders())) return send(ws, { type: 'projectResult', ok: false, error: 'Only opened folders can be taken off the list.' });
      projects.get(name)?.shutdown();
      projects.delete(name);
      forgetFolder(name);
      send(ws, { type: 'projectResult', ok: true, name });
      broadcastProjects();
      return;
    }
    case 'projectClone':
    case 'projectCreate':
    case 'projectOpenFolder': {
      const work =
        msg.type === 'projectClone' ? cloneProject(String(msg.repo ?? '').trim())
        : msg.type === 'projectCreate' ? createProject(String(msg.name ?? '').trim())
        : openFolder(String(msg.path ?? '').trim());
      work
        .then((name) => {
          send(ws, { type: 'projectResult', ok: true, name });
          broadcastProjects();
        })
        .catch((err) => send(ws, { type: 'projectResult', ok: false, error: String(err.stderr || err.message).split('\n')[0] }));
      return;
    }
    default: {
      const p = projects.get(clients.get(ws) ?? '');
      p?.onClient(msg);
    }
  }
}

// ---------- HTTP ----------

const isLoopback = (addr: string | undefined) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

function tokenOk(header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(hookToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('body too large');
  }
  return raw;
}

/**
 * Requests a web page in your browser could forge. Any Origin must be Forge's own page (no other site can drive it), and in
 * desktop mode the request must be addressed to this PC by name, so a site can't point its own domain at 127.0.0.1.
 */
function trusted(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (MODE === 'desktop' && host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

/** Desktop mode: the app's window opens /launch?key=…; the right key signs this browser in, with no password. */
function onLaunch(res: http.ServerResponse, url: URL): void {
  const key = url.searchParams.get('key') ?? '';
  if (MODE !== 'desktop' || !LAUNCH_KEY || key.length !== LAUNCH_KEY.length || !timingSafeEqual(Buffer.from(key), Buffer.from(LAUNCH_KEY))) {
    return json(res, 403, { error: 'Open Forge AIOS from its app.' });
  }
  auth.signIn(res, 'Strict');
  res.writeHead(302, { location: '/' });
  res.end();
}

/** Sign-in, sign-out, and setting the password (first with the setup code, then with the current password). */
async function onAuth(req: http.IncomingMessage, res: http.ServerResponse, action: string): Promise<void> {
  const ip = req.socket.remoteAddress ?? '';
  const body = JSON.parse((await readBody(req, 10_000)) || '{}');
  if (action === 'login') {
    const ok = auth.check(ip, String(body.password ?? ''));
    if (ok === null) return json(res, 429, { error: 'Too many wrong passwords. Wait a minute and try again.' });
    if (!ok) return json(res, 401, { error: auth.passwordSet ? 'That password is wrong.' : 'No password is set yet.' });
    auth.signIn(res);
    return json(res, 200, { ok: true });
  }
  if (action === 'logout') {
    auth.signOut(req, res);
    return json(res, 200, { ok: true });
  }
  if (action === 'password') {
    if (auth.passwordSet && !auth.allowed(req)) return json(res, 401, { error: 'Sign in first.' });
    const error = auth.setPassword(String(body.next ?? ''), String(body.proof ?? ''), ip);
    if (error) return json(res, 400, { error });
    auth.signIn(res);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
}

/** /hooks/<project>/<event> from a main session, /hooks/<project>/w/<worker>/<event> from a worker. */
async function onHook(req: http.IncomingMessage, res: http.ServerResponse, name: string, workerId: string | null, event: string): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress) || !tokenOk(req.headers['x-forge-hook-token'])) return json(res, 403, { error: 'forbidden' });
  const p = projects.get(name);
  if (!p) return json(res, 404, { error: 'no such project' });
  const body = JSON.parse((await readBody(req)) || '{}');
  const response = await p.onHook(res, event, workerId, body);
  if (!response) return json(res, 404, { error: 'no such worker' });
  if (!res.writableEnded && !res.destroyed) json(res, 200, response);
}

/** Allow / Deny buttons on a phone notification. Single-use token; no session rules from the phone. */
function onPhoneDecision(res: http.ServerResponse, id: string, url: URL): void {
  const d = url.searchParams.get('d');
  const t = url.searchParams.get('t') ?? '';
  if (d !== 'allow' && d !== 'deny') return json(res, 400, { error: 'd must be allow or deny' });
  for (const p of projects.values()) if (p.permissions.decideWithToken(id, d, t)) return json(res, 200, { ok: true, decision: d });
  json(res, 410, { error: 'This approval was already answered or has expired.' });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const file = path.normalize(path.join(STATIC, pathname === '/' ? 'index.html' : pathname));
  const target = file.startsWith(STATIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(STATIC, 'index.html');
  if (!fs.existsSync(target)) return json(res, 503, { error: 'The web app is not built. Run npm run build.' });
  const immutable = target.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const hook = req.method === 'POST' && url.pathname.match(/^\/hooks\/([\w.-]+)\/(?:w\/(w-[0-9a-f]+)\/)?(\w+)$/);
  if (hook) {
    onHook(req, res, hook[1], hook[2] ?? null, hook[3]).catch((err) => json(res, 500, { error: String(err) }));
    return;
  }
  // Phone buttons carry their own single-use token; they can't sign in.
  const phone = req.method === 'POST' && url.pathname.match(/^\/api\/approvals\/([\w-]+)\/decide$/);
  if (phone) return onPhoneDecision(res, phone[1], url);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, projects: projectNames().length });
  if (!trusted(req)) return json(res, 403, { error: 'forbidden' });
  if (req.method === 'GET' && url.pathname === '/launch') return onLaunch(res, url);
  if (req.method === 'GET' && url.pathname === '/api/auth') return json(res, 200, { signedIn: auth.allowed(req), passwordSet: auth.passwordSet, mode: MODE });
  // Desktop mode has no password: only sign-out is left.
  const authAction = req.method === 'POST' && url.pathname.match(MODE === 'desktop' ? /^\/api\/(logout)$/ : /^\/api\/(login|logout|password)$/);
  if (authAction) {
    onAuth(req, res, authAction[1]).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }
  if (url.pathname.startsWith('/api/') && !auth.allowed(req)) return json(res, 401, { error: 'Sign in first.' });
  if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, { projects: summaries(), default: defaultProject() });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const p = project(url.searchParams.get('project') ?? defaultProject() ?? '');
    if (!p) return json(res, 404, { error: 'no such project' });
    return json(res, 200, { session: p.sessionState(), agents: p.agents.list(), approvals: p.permissions.list(), rules: p.permissions.rules() });
  }
  if (req.method === 'GET') return serveStatic(res, url.pathname);
  json(res, 404, { error: 'not found' });
});

// A browser opens a project with ?project=… or an 'open' message; without either it gets the default one (tests rely on this).
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  if (!trusted(req)) return ws.close(4403, 'Forbidden.');
  if (!auth.allowed(req)) return ws.close(4401, 'Sign in first.');
  const asked = new URL(req.url ?? '/ws', 'http://localhost').searchParams.get('project');
  const p = project(asked ?? '') ?? project(defaultProject() ?? '');
  clients.set(ws, p?.name ?? '');
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    try {
      onClient(ws, JSON.parse(String(raw)));
    } catch (err) {
      send(ws, { type: 'error', error: String(err) });
    }
  });
  if (p) send(ws, p.hello());
  send(ws, { type: 'projects', projects: summaries() });
});

// Projects with history load at startup, so their sessions show in the sidebar and their subagents are rebuilt.
for (const name of projectNames()) if (Project.hasHistory(DATA, name)) project(name);
project(defaultProject() ?? '');

// Desktop mode is for this PC alone; server mode is reached over the network.
server.listen(PORT, MODE === 'desktop' ? '127.0.0.1' : undefined, () => console.log(`Forge AIOS on :${PORT}, ${projectNames().length} projects in ${REPOS}, phone ${globals.notifier.enabled ? 'on' : 'off'}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const p of projects.values()) p.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
