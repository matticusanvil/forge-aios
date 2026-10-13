// Forge AIOS for Windows: runs the Forge server on this PC, in desktop mode, and shows it in a window.
// The first run (or a missing piece later) opens setup: Git, Claude Code, signing in to Claude, and a projects folder.

const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage } = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// Packaged, Forge and its Node live in the app's resources; from source, the repo and the Node on the PATH (or FORGE_NODE).
const FORGE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'forge') : path.join(__dirname, '..');
const NODE = app.isPackaged ? path.join(process.resourcesPath, 'node', 'node.exe') : process.env.FORGE_NODE || 'node';
const ICON = path.join(__dirname, 'icon.png');
const USER_DIR = app.getPath('userData'); // %APPDATA%\Forge AIOS
const SETTINGS_FILE = path.join(USER_DIR, 'settings.json');
const LOG_FILE = path.join(USER_DIR, 'server.log');
// Where Anthropic's Windows installer puts Claude Code; it doesn't always add that folder to the PATH.
const CLAUDE_EXE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const GIT_DIRS = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git'), path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git')];

let settings = readSettings();
let server = null;
let base = null; // http://127.0.0.1:<port>
let win = null;
let setupWin = null;
let tray = null;
let quitting = false;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** Runs a program and gives back what it printed; never throws. */
function run(file, args, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 10_000_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

/** Git for Windows: its folder, found where its installer puts it or on the PATH. */
async function findGit() {
  for (const dir of GIT_DIRS) if (fs.existsSync(path.join(dir, 'cmd', 'git.exe'))) return dir;
  const where = await run('where.exe', ['git']);
  const exe = where.ok && where.stdout.split(/\r?\n/)[0].trim();
  return exe ? path.dirname(path.dirname(exe)) : null;
}

async function findClaude() {
  if (fs.existsSync(CLAUDE_EXE)) return CLAUDE_EXE;
  const where = await run('where.exe', ['claude']);
  return (where.ok && where.stdout.split(/\r?\n/)[0].trim()) || null;
}

async function signedIn(claude) {
  if (!claude) return false;
  const r = await run(claude, ['auth', 'status']);
  try {
    return JSON.parse(r.stdout).loggedIn === true;
  } catch {
    return false;
  }
}

/** Where setup stands: what's installed, whether Claude Code is signed in, and the projects folder. */
async function status() {
  const [git, claude] = await Promise.all([findGit(), findClaude()]);
  return {
    git: !!git,
    claude: !!claude,
    signedIn: await signedIn(claude),
    folder: settings.projectsFolder || path.join(os.homedir(), 'Forge AIOS'),
    folderChosen: !!settings.projectsFolder,
  };
}

const ready = (s) => s.git && s.claude && s.signedIn && s.folderChosen;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function healthy(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => resolve(res.statusCode === 200)).on('error', () => resolve(false));
  });
}

/** Starts Forge in desktop mode on a free port, with a new launch key; resolves once it answers. */
async function startServer() {
  const folder = settings.projectsFolder;
  fs.mkdirSync(folder, { recursive: true });
  // A first project, so the cockpit has somewhere to start.
  if (!fs.readdirSync(folder, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.'))) {
    fs.mkdirSync(path.join(folder, 'welcome'));
    fs.writeFileSync(path.join(folder, 'welcome', 'README.md'), '# Welcome\n\nA first project for Forge AIOS. Ask Claude anything here, or add your own projects from the Projects page.\n');
  }
  const port = await freePort();
  const key = crypto.randomBytes(24).toString('hex');
  const gitDir = await findGit();
  const claude = await findClaude();
  const env = {
    ...process.env,
    FORGE_MODE: 'desktop',
    FORGE_LAUNCH_KEY: key,
    PORT: String(port),
    FORGE_DATA: path.join(USER_DIR, 'data'),
    FORGE_REPOS: folder,
    FORGE_PROJECT: path.join(folder, 'welcome'),
    ...(claude && { FORGE_CLAUDE: claude }),
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    // Claude Code runs shell commands with Git Bash; it may have been installed after this app started.
    ...(gitDir && { CLAUDE_CODE_GIT_BASH_PATH: path.join(gitDir, 'bin', 'bash.exe'), PATH: `${path.join(gitDir, 'cmd')};${process.env.PATH}` }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(LOG_FILE, 'w');
  server = spawn(NODE, [path.join(FORGE_DIR, 'server', 'main.ts')], { cwd: FORGE_DIR, env, windowsHide: true, stdio: ['ignore', log, log] });
  server.on('exit', () => {
    server = null;
    if (quitting) return;
    dialog.showErrorBox('Forge AIOS stopped', `Forge AIOS stopped unexpectedly. Its log is at:\n${LOG_FILE}`);
    app.quit();
  });
  for (let i = 0; i < 60; i++) {
    if (await healthy(port)) return { port, key };
    if (!server) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Forge AIOS didn't start. Its log is at ${LOG_FILE}`);
}

/** Stops Forge and every Claude Code process it started (Windows needs taskkill for the whole tree). */
function stopServer() {
  if (!server?.pid) return Promise.resolve();
  return new Promise((resolve) => execFile('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

const isWeb = (url) => /^https?:\/\//i.test(url);

function openMain(port, key) {
  base = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0b',
    title: 'Forge AIOS',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // Links to other sites open in the browser; the window only ever shows Forge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(base)) return;
    event.preventDefault();
    if (isWeb(url)) shell.openExternal(url);
  });
  win.on('close', (event) => {
    if (quitting) return;
    // Closing the window keeps Forge running in the tray, so agents can finish; Quit is in the tray menu.
    event.preventDefault();
    win.hide();
    if (!settings.trayNoticeShown) {
      tray?.displayBalloon({ title: 'Forge AIOS is still running', content: 'Your sessions keep going. Open Forge AIOS or quit it from this icon.', iconType: 'info' });
      saveSettings({ trayNoticeShown: true });
    }
  });
  win.loadURL(`${base}/launch?key=${key}`);
}

function showMain() {
  if (!win) return;
  win.show();
  win.focus();
}

function makeTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Forge AIOS');
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open Forge AIOS', click: showMain },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { label: 'Open the log', click: () => shell.openPath(LOG_FILE) },
      { type: 'separator' },
      { label: 'Quit Forge AIOS', click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', showMain);
}

function openSetup() {
  setupWin = new BrowserWindow({
    width: 760,
    height: 640,
    resizable: false,
    backgroundColor: '#0a0a0b',
    title: 'Set up Forge AIOS',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.on('closed', () => {
    setupWin = null;
    if (!win) app.quit();
  });
}

async function launch() {
  const port = await startServer().catch((err) => {
    dialog.showErrorBox('Forge AIOS', String(err.message ?? err));
    app.quit();
    return null;
  });
  if (!port) return;
  makeTray();
  openMain(port.port, port.key);
  if (process.argv.includes('--hidden')) win.hide();
}

// ---------- what the setup page and the Forge window may ask for ----------

ipcMain.handle('status', () => status());

ipcMain.handle('install', async (_e, what) => {
  if (what === 'git') {
    const winget = await run('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent'], 900_000);
    if (!winget.ok && !(await findGit())) {
      shell.openExternal('https://git-scm.com/downloads/win');
      return { ok: false, message: 'Windows couldn’t install Git automatically, so its download page is open in your browser. Install it, then press Check again.' };
    }
    return { ok: true };
  }
  if (what === 'claude') {
    // Anthropic's own installer, exactly as Anthropic publishes it.
    const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], 900_000);
    return (await findClaude()) ? { ok: true } : { ok: false, message: `Claude Code didn’t install. ${r.stderr.slice(-400)}` };
  }
  return { ok: false, message: 'Unknown step.' };
});

// Sign-in happens in Claude Code's own window, through Anthropic's sign-in; Forge never sees the account or the key.
ipcMain.handle('signIn', async () => {
  const claude = await findClaude();
  if (!claude) return { ok: false, message: 'Install Claude Code first.' };
  execFile('cmd.exe', ['/c', 'start', 'Sign in to Claude Code', claude], { windowsHide: true });
  return { ok: true };
});

ipcMain.handle('pickFolder', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(owner, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('finish', async (_e, folder) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { ok: false, message: 'Choose a folder for your projects.' };
  saveSettings({ projectsFolder: folder });
  const s = await status();
  if (!ready(s)) return { ok: false, message: 'A step above isn’t done yet.' };
  setupWin?.removeAllListeners('closed');
  setupWin?.close();
  setupWin = null;
  await launch();
  return { ok: true };
});

// ---------- app lifetime ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => (win ? showMain() : setupWin?.focus()));
  app.whenReady().then(async () => {
    app.setAppUserModelId('ca.anvildigital.forgeaios');
    if (ready(await status())) await launch();
    else openSetup();
  });
  app.on('before-quit', async (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    await stopServer();
    app.quit();
  });
  app.on('window-all-closed', () => {}); // the tray keeps the app alive
}
