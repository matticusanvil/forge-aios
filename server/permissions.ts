import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { toolSummary } from '../shared/text.ts';
import type { ApprovalLevel, Approval } from '../shared/types.ts';
import type { EventLog } from './eventlog.ts';

export type { Approval } from '../shared/types.ts';

// Tools that only read. With "auto-allow read-only tools" on (the default), these never ask.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
// Tools that only plan, delegate or check on background work; they never ask (the agent limits govern spawning).
const ALWAYS_ALLOW = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillShell', 'KillBash',
  'Agent', 'Task', 'ToolSearch', 'Skill', 'EnterPlanMode',
]);
// "Trusted project": commands that only look around…
const LOOK_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'grep', 'rg', 'find', 'which', 'file', 'stat', 'du', 'df', 'tree', 'sort', 'uniq',
  'diff', 'cut', 'basename', 'dirname', 'realpath', 'date', 'true',
  'git status', 'git diff', 'git log', 'git show', 'git blame', 'git rev-parse', 'git ls-files',
]);
// …and ones that build, test and commit inside the project. Not here, so still asking: rm, git push, curl, sudo, docker and the like.
const WORK_COMMANDS = new Set([
  ...['npm', 'pnpm', 'yarn', 'bun'].flatMap((m) => [`${m} test`, `${m} run`, `${m} install`, `${m} i`, `${m} ci`, `${m} add`]),
  'npx tsc', 'npx vitest', 'npx jest', 'npx eslint', 'npx prettier', 'npx vite', 'npx playwright', 'npx next', 'npx tsx',
  'node', 'tsc', 'python', 'python3', 'pytest', 'go test', 'go build', 'go run', 'go vet', 'cargo build', 'cargo test', 'cargo run', 'cargo check', 'make',
  'mkdir', 'touch', 'cp', 'mv',
  'git add', 'git commit', 'git switch', 'git checkout', 'git stash', 'git restore', 'git mv', 'git init',
]);
// Commands a wiki builder may run inside its own wiki without asking.
const BUILDER_COMMANDS = new Set(['git add', 'git commit', 'git status', 'git log', 'git diff', 'git mv', 'mkdir', 'ls', 'mv', 'cat']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Tools that need a terminal the user isn't at. The reason tells Claude what to do instead.
const UNAVAILABLE: Record<string, string> = {
  AskUserQuestion: 'Forge AIOS cannot show multiple-choice questions. Ask the user in your reply instead, then end your turn.',
};

// The CLI's hook times out at an hour (session.ts); give up a little before, so the answer is ours.
const APPROVAL_TTL_MS = 55 * 60_000;

export type Decision = 'allow' | 'deny' | 'allow-session';
export type DecidedBy = 'browser' | 'phone' | 'timeout' | 'interrupt' | 'reset';
export type Verdict = { decision: 'allow' | 'deny'; reason?: string };

type Pending = { approval: Approval; token: string; resolve: (v: Verdict) => void; timer: NodeJS.Timeout };
type RecordFn = (kind: string, agentId: string | null, payload: unknown) => void;

/** True when a command names no path outside `dir`: no "..", no "~", no absolute path elsewhere, no command substitution. */
export function staysInside(command: string, dir: string): boolean {
  if (/\$\(|`|(^|[\s'"=:])~|(^|[\s/'"=])\.\.(\/|[\s'"]|$)/.test(command)) return false;
  return command.split(/\s+/).every((w) => {
    const word = w.replace(/^[0-9]*[<>]+&?/, '').replace(/^['"]/, '').replace(/['"]$/, '');
    return !word.startsWith('/') || word === dir || word.startsWith(`${dir}/`) || word === '/dev/null';
  });
}

/** True for a command that only looks around, or (with work) also builds, tests and commits, entirely inside `dir`. */
export function trustedCommand(command: string, dir: string, work: boolean): boolean {
  if (!staysInside(command, dir)) return false;
  // find can run or delete things; a plain ">" overwrites files (look-around commands only print).
  if (/\s-(exec|execdir|delete|ok|fprint)\b/.test(command)) return false;
  return commandSegments(command).every((seg) => {
    const prefix = commandPrefix(seg);
    if (LOOK_COMMANDS.has(prefix) && !/(^|[^0-9&])>(?!&)/.test(seg.replace(/[0-9]?>\s*\/dev\/null/g, ''))) return true;
    return work && WORK_COMMANDS.has(prefix);
  });
}

/** Splits a shell command into the commands it runs, so "a && b" needs a rule for both. Quote-unaware, so it errs towards asking. */
export function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

// Programs whose second word is a subcommand that changes what they do: "git status" and "git push" are different asks.
const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'docker', 'cargo', 'go', 'pip', 'pip3', 'uv',
  'gh', 'kubectl', 'make', 'systemctl', 'apt', 'apt-get', 'brew', 'vercel', 'supabase', 'claude',
]);

/** "npm test", "git status", "ls": the program, plus its subcommand for programs that have them. Ignores leading VAR=value. */
export function commandPrefix(segment: string): string {
  const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const [program = '', sub] = words;
  return sub && SUBCOMMAND_PROGRAMS.has(program) && /^[a-z][a-z0-9:_-]*$/i.test(sub) ? `${program} ${sub}` : program;
}

/** The rules a call needs, as key → label. */
export function rulesFor(tool: string, input: Record<string, unknown>): Map<string, string> {
  if (tool === 'Bash') {
    const prefixes = commandSegments(String(input.command ?? '')).map(commandPrefix);
    return new Map(prefixes.map((p) => [`bash:${p}`, `${p} …`]));
  }
  if (EDIT_TOOLS.has(tool)) return new Map([['edits', 'all file edits']]);
  return new Map([[`tool:${tool}`, tool]]);
}

function why(tool: string, input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description) return input.description;
  if (tool === 'Write') return `Creates or overwrites ${input.file_path}.`;
  if (EDIT_TOOLS.has(tool)) return `Changes ${input.file_path ?? input.notebook_path}.`;
  return '';
}

/**
 * Decides every tool call through the PreToolUse hook: auto-allow, a remembered rule, or the user's answer.
 * Emits 'changed' whenever the set of pending approvals changes, and 'requested' with (approval, token) for phone pushes.
 */
export class Permissions extends EventEmitter {
  private pending = new Map<string, Pending>();
  private store: EventLog;
  private record: RecordFn;
  autoAllowReadOnly = true;
  /** The session's approval level (Rules page). */
  level: ApprovalLevel = 'project';
  /** The project folder: "Trusted project" allows work inside it. */
  private projectDir: string;
  /** Linked context wikis: nothing edits them (read only, by your choice). */
  readOnlyDirs: string[] = [];
  /** Wiki builder workers (agent id → their wiki folder): edits and basic git inside it run without asking. */
  builders = new Map<string, string>();

  constructor(opts: { store: EventLog; record: RecordFn; projectDir: string }) {
    super();
    this.projectDir = path.resolve(opts.projectDir);
    this.store = opts.store;
    this.record = opts.record;
  }

  list(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  rules(): { key: string; label: string }[] {
    return this.store.rules();
  }

  /** `signal` aborts when the CLI abandons the call (interrupt, exit), so its card doesn't linger. */
  check(agentId: string | null, tool: string, input: Record<string, unknown>, toolUseId?: string, signal?: AbortSignal): Promise<Verdict> | Verdict {
    if (ALWAYS_ALLOW.has(tool) || (this.autoAllowReadOnly && READ_ONLY.has(tool))) return { decision: 'allow' };
    if (UNAVAILABLE[tool]) return { decision: 'deny', reason: UNAVAILABLE[tool] };
    const file = String(input.file_path ?? input.notebook_path ?? '');
    if (EDIT_TOOLS.has(tool) && this.readOnlyDirs.some((d) => file === d || file.startsWith(`${d}/`))) {
      this.record('approval.auto', agentId, { tool, summary: toolSummary(tool, input), refused: 'linked wiki is read only' });
      return { decision: 'deny', reason: 'That file is in a linked context wiki, which is read only in this session. Don’t change it; tell the user what you would change instead.' };
    }
    const builderDir = agentId ? this.builders.get(agentId) : undefined;
    if (builderDir) {
      const inside = EDIT_TOOLS.has(tool) && file.startsWith(`${builderDir}/`);
      const command = String(input.command ?? '');
      // Its own commands, and only paths inside its wiki: no "..", no "~", no absolute path elsewhere.
      const staysInside = !/\.\.|~/.test(command) && command.split(/\s+/).every((w) => !w.replace(/^['"]/, '').startsWith('/') || w.replace(/^['"]/, '').startsWith(`${builderDir}/`) || w.replace(/^['"]/, '') === builderDir);
      const safeShell = tool === 'Bash' && staysInside && commandSegments(command).every((seg) => BUILDER_COMMANDS.has(commandPrefix(seg)));
      if (inside || safeShell) return { decision: 'allow' };
    }
    if (this.level === 'all') return { decision: 'allow' };
    if (this.level === 'project') {
      const dir = this.projectDir;
      const target = file && path.resolve(dir, file);
      const editInside = EDIT_TOOLS.has(tool) && !!target && target.startsWith(`${dir}/`) && !target.startsWith(`${dir}/.git/`);
      if (editInside || (tool === 'Bash' && trustedCommand(String(input.command ?? ''), dir, true))) return { decision: 'allow' };
    }
    const needed = rulesFor(tool, input);
    const have = new Set(this.store.rules().map((r) => r.key));
    if ([...needed.keys()].every((k) => have.has(k))) {
      this.record('approval.auto', agentId, { tool, summary: toolSummary(tool, input), rules: [...needed.values()] });
      return { decision: 'allow' };
    }

    const approval: Approval = {
      id: randomUUID(),
      agentId,
      toolUseId,
      tool,
      input,
      summary: toolSummary(tool, input),
      why: why(tool, input),
      ruleLabel: [...needed.values()].join(', '),
      requestedAt: new Date().toISOString(),
    };
    const token = randomBytes(24).toString('base64url');
    return new Promise<Verdict>((resolve) => {
      const timer = setTimeout(() => this.settle(approval.id, 'deny', 'timeout', 'No answer from the user in time.'), APPROVAL_TTL_MS);
      this.pending.set(approval.id, { approval, token, resolve, timer });
      signal?.addEventListener('abort', () => this.settle(approval.id, 'deny', 'interrupt', 'The tool call was cancelled.'), { once: true });
      this.record('approval.requested', agentId, approval);
      this.emit('requested', approval, token);
      this.emit('changed');
    });
  }

  /** An answer from the browser. */
  decide(id: string, decision: Decision, note?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (decision === 'allow-session') {
      for (const [key, label] of rulesFor(p.approval.tool, p.approval.input)) this.store.addRule(key, label);
    }
    return this.settle(id, decision === 'deny' ? 'deny' : 'allow', 'browser', note, decision);
  }

  /** An answer from a phone notification button, which carries the approval's single-use token. */
  decideWithToken(id: string, decision: 'allow' | 'deny', token: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    const given = Buffer.from(token);
    const expected = Buffer.from(p.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    return this.settle(id, decision, 'phone', undefined, decision);
  }

  /** Refuses everything still waiting, e.g. on interrupt or a new session. */
  denyAll(by: DecidedBy, reason: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'deny', by, reason);
  }

  clearRules(): void {
    this.store.clearRules();
  }

  removeRule(key: string): void {
    this.store.removeRule(key);
    this.emit('changed');
  }

  private settle(id: string, verdict: 'allow' | 'deny', by: DecidedBy, note?: string, decision: Decision = verdict): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const reason = verdict === 'deny' ? (by === 'browser' || by === 'phone' ? deniedReason(note) : note) : undefined;
    p.resolve({ decision: verdict, reason });
    this.record('approval.decided', p.approval.agentId, { id, decision, by, note: note ?? null });
    this.emit('decided', p.approval);
    this.emit('changed');
    return true;
  }
}

const deniedReason = (note?: string) =>
  note ? `The user denied this tool call, with this note: ${note}` : 'The user denied this tool call. Ask them how to proceed if you need it.';
