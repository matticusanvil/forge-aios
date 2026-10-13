import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const windows = process.platform === 'win32';
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

/** Forge's own data (project databases, rules defaults, sign-in): FORGE_DATA, else the platform's usual place. */
export const DATA_DIR = process.env.FORGE_DATA ?? (windows ? path.join(localAppData, 'Forge AIOS') : '/data');

/** The project a new browser opens first; every folder beside it is a project too. */
export const DEFAULT_PROJECT = process.env.FORGE_PROJECT ?? (windows ? path.join(os.homedir(), 'Forge AIOS', 'playground') : '/srv/repos/playground');

/**
 * The Claude Code command: FORGE_CLAUDE (a full path), else where Anthropic's Windows installer puts it
 * (it doesn't always add that folder to the PATH), else `claude` from the PATH.
 */
export const CLAUDE = process.env.FORGE_CLAUDE ?? (() => {
  const installed = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  return windows && fs.existsSync(installed) ? installed : 'claude';
})();

/** Ends a process and everything it started. On Windows a signal ends only the process itself, so taskkill ends the tree. */
export function killTree(child: ChildProcess): void {
  if (windows && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

/**
 * "desktop": one person on this PC, started by the Forge AIOS app: it listens on this PC only, has no password,
 * and the app's window signs in with FORGE_LAUNCH_KEY, a new random key each launch.
 * "server" (the default): the Docker setup, reached over the network, behind the shared password.
 */
export const MODE: 'desktop' | 'server' = process.env.FORGE_MODE === 'desktop' ? 'desktop' : 'server';
export const LAUNCH_KEY = process.env.FORGE_LAUNCH_KEY ?? '';
