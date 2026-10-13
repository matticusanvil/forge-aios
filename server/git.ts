import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitState } from '../shared/types.ts';

const run = promisify(execFile);

// An untracked file's lines all count as added; past this size it's not worth reading.
const MAX_UNTRACKED_BYTES = 1_000_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5_000, maxBuffer: 4_000_000 });
  return stdout;
}

function lineCount(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return null;
  }
}

/** The project's working-tree changes against HEAD: what the agents (or anyone) changed and haven't committed. */
export async function gitState(cwd: string): Promise<GitState> {
  try {
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
    const hasHead = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
    const numstat = hasHead ? await git(cwd, ['diff', '--numstat', 'HEAD', '--']) : '';
    const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);

    const counts = new Map<string, { added: number | null; removed: number | null }>();
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [a, r, ...rest] = line.split('\t');
      counts.set(rest.join('\t'), { added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) });
    }

    const files: GitState['files'] = [];
    for (const line of status.split('\n').filter(Boolean)) {
      const code = line.slice(0, 2);
      let file = line.slice(3);
      if (file.includes(' -> ')) file = file.split(' -> ')[1];
      file = file.replace(/^"(.*)"$/, '$1');
      if (code === '??') {
        files.push({ file, status: 'untracked', added: lineCount(path.join(cwd, file)), removed: 0 });
        continue;
      }
      const c = counts.get(file) ?? { added: null, removed: null };
      const kind = code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code.includes('R') ? 'renamed' : 'modified';
      files.push({ file, status: kind, ...c });
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    return { branch, files };
  } catch (err) {
    const message = String((err as { stderr?: string }).stderr || (err as Error).message);
    return { branch: null, files: [], error: /not a git repository/i.test(message) ? 'Not a git repository.' : message.split('\n')[0] };
  }
}

/**
 * Keeps the git state fresh: after tool calls that may have changed files (debounced), and on a slow poll
 * for changes made outside Forge. Calls onChange only when something actually changed.
 */
export class GitWatcher {
  state: GitState = { branch: null, files: [] };
  private cwd: string;
  private onChange: (state: GitState) => void;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;

  constructor(cwd: string, onChange: (state: GitState) => void) {
    this.cwd = cwd;
    this.onChange = onChange;
    setInterval(() => this.refresh(), 15_000).unref();
    this.refresh();
  }

  /** Something may have changed files: look again shortly. */
  poke(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 700);
  }

  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      const next = await gitState(this.cwd);
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        this.state = next;
        this.onChange(next);
      }
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.refresh();
      }
    }
  }
}
