import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'] as const;

// If either is set, the CLI bills the API instead of the subscription without saying so (plan: Risks).
const BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export type SessionOptions = {
  cwd: string;
  /** Base URL the CLI posts hook calls to; the event name is appended. */
  hookUrl: string;
  hookToken: string;
  /** Pre-approved tools; normally empty, since the PreToolUse hook decides every call. */
  allowedTools?: string[];
  /** Appended to Claude Code's default system prompt. */
  systemPrompt: string;
  /** A CLI session id to continue, after a restart. */
  resume?: string | null;
  /** Model alias (opus, sonnet, haiku, fable); omitted = the CLI's default. */
  model?: string;
  /** Extra folders the session may read (linked context wikis). */
  addDirs?: string[];
  /** The session's name, shown by Claude Code (e.g. in /resume). */
  name?: string;
};

// PreToolUse may wait on the user's approval, so it gets an hour; the others answer at once.
const HOOK_TIMEOUT_S: Record<string, number> = { PreToolUse: 3600 };

/**
 * One headless `claude` process for one project, talking stream-json on stdin/stdout.
 * Hooks are passed with --settings, so nothing is written into the project's own .claude folder.
 */
export class Session extends EventEmitter {
  sessionId: string | null = null;
  private opts: SessionOptions;
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Sends a user message, starting the process on the first one. */
  send(text: string): void {
    const child = this.child ?? this.start();
    const message = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.sessionId ?? '' };
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Stops the current turn, as Esc does in the terminal. The process stays up for the next message. */
  interrupt(): boolean {
    if (!this.child) return false;
    const request = { type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } };
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return true;
  }

  /** Ends an idle process gracefully (parking); the next send() resumes the same conversation. */
  close(): void {
    this.child?.stdin.end();
  }

  /** Ends the process: interrupts any turn in progress, closes stdin, and terminates it if it hangs. */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.interrupt();
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
    child.once('exit', () => clearTimeout(timer));
  }

  private start(): ChildProcessWithoutNullStreams {
    const { cwd, hookUrl, hookToken, allowedTools = [], systemPrompt, model, addDirs = [], name } = this.opts;
    // After a park or crash, pick up the conversation this process already had.
    const resume = this.sessionId ?? this.opts.resume;
    const hook = (event: string) => ({
      type: 'http',
      url: `${hookUrl}/${event}`,
      headers: { 'X-Forge-Hook-Token': hookToken },
      ...(HOOK_TIMEOUT_S[event] && { timeout: HOOK_TIMEOUT_S[event] }),
    });
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((event) => [event, [event.endsWith('ToolUse') ? { matcher: '*', hooks: [hook(event)] } : { hooks: [hook(event)] }]]),
    );
    const env = { ...process.env };
    for (const key of BILLING_ENV) delete env[key];
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--forward-subagent-text',
      '--settings', JSON.stringify({ hooks }),
      '--append-system-prompt', systemPrompt,
      ...(resume ? ['--resume', resume] : []),
      ...(model ? ['--model', model] : []),
      ...(name ? ['--name', name] : []),
      ...addDirs.flatMap((d) => ['--add-dir', d]),
      // --allowedTools is variadic, so it goes last (phase 0 finding).
      ...(allowedTools.length ? ['--allowedTools', ...allowedTools] : []),
    ];
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m: Record<string, any>;
      try {
        m = JSON.parse(line);
      } catch {
        this.emit('stderr', line);
        return;
      }
      if (m.type === 'system' && m.subtype === 'init') this.sessionId = m.session_id;
      this.emit('message', m);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => this.emit('stderr', line));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.emit('exit', { code, signal });
    });
    return child;
  }
}
