import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddAgentRequest, EventSource } from '../shared/types.ts';
import { workerSystemPrompt, type Agents } from './agents.ts';
import { Session } from './session.ts';

type RecordFn = (source: EventSource, kind: string, agentId: string | null, payload: unknown) => void;

type Deps = { cwd: string; hookBase: string; hookToken: string; agents: Agents; record: RecordFn };

const streamKind = (m: Record<string, any>) => (m.subtype ? `${m.type}/${m.subtype}` : String(m.type));

/**
 * Workers: Claude processes the user starts by hand with Add agent, each with its own model and conversation,
 * in the same project as the main session. Hooks reach the server at /hooks/w/<id>/…, so every tool call
 * goes through the same steering and approvals as everything else, filed under the worker's id.
 */
export class Workers extends EventEmitter {
  private sessions = new Map<string, Session>();
  private busy = new Set<string>();
  private deps: Deps;

  constructor(deps: Deps) {
    super();
    this.deps = deps;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Emits 'idle' (id) when a worker's turn ends with nothing more to send it. `cwd` defaults to the project. */
  start(r: AddAgentRequest, opts: { cwd?: string; addDirs?: string[] } = {}): string {
    const { hookBase, hookToken, agents, record } = this.deps;
    const cwd = opts.cwd ?? this.deps.cwd;
    const id = `w-${randomBytes(5).toString('hex')}`;
    agents.addWorker(id, r.name, r.model);
    record('forge', 'worker.started', id, { name: r.name, model: r.model, task: r.task });
    const s = new Session({ cwd, hookUrl: `${hookBase}/w/${id}`, hookToken, systemPrompt: workerSystemPrompt(agents.trustTag, r.name), model: r.model, addDirs: opts.addDirs, name: r.name });
    s.on('message', (m: Record<string, any>) => this.onMessage(id, m));
    s.on('stderr', (line: string) => record('forge', 'session.stderr', id, { line }));
    s.on('exit', (info) => {
      record('forge', 'worker.exited', id, info);
      if (this.sessions.has(id)) this.emit('exited', id);
      this.sessions.delete(id);
      this.busy.delete(id);
      agents.closeWorker(id);
    });
    this.sessions.set(id, s);
    this.busy.add(id);
    s.send(r.task);
    return id;
  }

  /** A message from you: starts a turn if the worker is idle, or reaches it at its next step if it's working. */
  message(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const { agents, record } = this.deps;
    if (this.busy.has(id)) {
      agents.queueNote(id, text);
    } else {
      record('forge', 'user.message', id, { text });
      this.busy.add(id);
      agents.workerBusy(id);
      s.send(text);
    }
    return true;
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.busy.delete(id);
    s.stop();
    this.deps.record('forge', 'worker.closed', id, {});
    this.deps.agents.closeWorker(id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private onMessage(id: string, m: Record<string, any>): void {
    if (m.type === 'stream_event') return; // live text is shown for the main session only
    const { agents, record } = this.deps;
    agents.onStream(m);
    record('stream', streamKind(m), agents.agentFor(m) ?? id, m);
    if (m.type !== 'result') return;
    // Anything you sent while it was working that no tool call picked up becomes its next message.
    const notes = agents.takeNotes(id);
    if (notes.length) {
      this.sessions.get(id)?.send(notes.map((n) => n.text).join('\n\n'));
    } else {
      this.busy.delete(id);
      agents.workerIdle(id);
      this.emit('idle', id);
    }
  }
}
