import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { APPROVAL_LEVELS, MODELS, modelAlias, type AddAgentRequest, type ApprovalLevel, type EventSource, type ProjectSummary, type Rules } from '../shared/types.ts';

export type { ProjectSummary } from '../shared/types.ts';
import { Agents, isDenied, mainSystemPrompt, steerHeader, type HookResponse, type SteerMode } from './agents.ts';
import { EventLog } from './eventlog.ts';
import { GitWatcher } from './git.ts';
import type { Notifier } from './notify.ts';
import { Permissions, type Decision } from './permissions.ts';
import { RulesStore, sanitize } from './rules.ts';
import { Session } from './session.ts';
import { sessionTranscript } from './transcript.ts';
import { slug, type Wikis } from './wikis.ts';
import { Workers } from './workers.ts';

const MODEL_IDS = new Set<string>(MODELS.map((m) => m.id));

// An idle session's process is parked after this long, and resumes on the next message.
const PARK_MS = Number(process.env.FORGE_PARK_MINUTES ?? 30) * 60_000;

/** What every project shares: the account, the hook endpoint, phone pushes, the wikis. */
export type Globals = {
  dataDir: string;
  /** Hook URL base; the project adds its own name. */
  hookBase: string;
  hookToken: string;
  allowedTools: string[];
  notifier: Notifier;
  wikis: Wikis;
  /** Account-wide state shown in every project's top bar. */
  account: () => { login: unknown; rateLimits: unknown; claude: { version: string; tested: boolean } | null };
  setRateLimits: (r: unknown) => void;
};


export type ClientMessage =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'decide'; id: string; decision: Decision; note?: string }
  | { type: 'steer'; agentId: string | null; text: string }
  | { type: 'stop'; agentId: string }
  | { type: 'config'; steerMode?: SteerMode; phoneMuted?: boolean; maxRunning?: number | null }
  | { type: 'addAgent'; request: Partial<AddAgentRequest> }
  | { type: 'closeAgent'; agentId: string }
  | { type: 'setRules'; rules: Partial<Rules> }
  | { type: 'setDefaults'; rules: Partial<Rules> }
  | { type: 'removeRule'; key: string }
  | { type: 'wikiAdd'; repo: string }
  | { type: 'wikiCreate'; name: string; subject?: string; publish?: boolean }
  | { type: 'wikiRemove'; id: string }
  | { type: 'nameSession'; name: string }
  | { type: 'reset'; model?: string; name?: string; approvals?: ApprovalLevel };

const streamKind = (m: Record<string, any>) => (m.subtype ? `${m.type}/${m.subtype}` : String(m.type));
const errText = (err: unknown) => String((err as { stderr?: string }).stderr || (err as Error).message || err).split('\n')[0];

/**
 * One repo under /srv/repos and everything Forge runs for it: its event log, main session, subagents, workers,
 * approvals, rules and git watcher. Projects run side by side; switching in the browser only changes which one you watch.
 * Emits 'message' (msg) for the browsers watching this project, and 'summary' when its sidebar status changes.
 */
export class Project extends EventEmitter {
  readonly name: string;
  readonly dir: string;
  readonly store: EventLog;
  readonly agents: Agents;
  readonly permissions: Permissions;
  readonly workers: Workers;
  readonly git: GitWatcher;
  private g: Globals;
  private rulesStore: RulesStore;
  private rules: Rules;
  private session: Session;
  private pendingRestart = false;
  private parkTimer: NodeJS.Timeout | null = null;
  private parking = false;
  private status = { busy: false, turnStartedAt: 0, apiKeySource: null as string | null, model: null as string | null, agentTypes: [] as string[] };

  constructor(name: string, dir: string, g: Globals) {
    super();
    this.name = name;
    this.dir = dir;
    this.g = g;
    this.store = new EventLog(path.join(g.dataDir, `${name}.db`));
    const forgeRecord = (kind: string, agentId: string | null, payload: unknown) => this.record('forge', kind, agentId, payload);
    this.agents = new Agents({ steerMode: process.env.FORGE_STEER_MODE === 'deny' ? 'deny' : 'context', record: forgeRecord });
    this.recover();
    this.permissions = new Permissions({ store: this.store, record: forgeRecord, projectDir: dir });
    this.rulesStore = new RulesStore(g.dataDir, this.store);
    this.rules = this.rulesStore.session();
    this.rules.wikis = this.rules.wikis.filter((id) => g.wikis.ids().has(id));

    this.agents.on('changed', () => {
      this.emit('message', { type: 'agents', agents: this.agents.list() });
      this.emit('summary');
    });
    this.permissions.on('changed', () => {
      this.emit('message', { type: 'approvals', approvals: this.permissions.list(), rules: this.permissions.rules() });
      this.broadcastSession();
      this.emit('summary');
    });
    this.permissions.on('requested', (a, token) => {
      if (this.rules.phone) g.notifier.approval(a.id, token, `${name} needs you`, `${this.who(a.agentId)}: ${a.summary}`);
    });
    this.permissions.on('decided', (a) => g.notifier.clear(a.id));

    this.applyRules();
    this.session = this.newSession(this.store.getMeta('sessionId'));
    for (const id of this.rules.wikis) g.wikis.pull(id);
    this.git = new GitWatcher(dir, (git) => this.emit('message', { type: 'git', git }));
    this.workers = new Workers({ cwd: dir, hookBase: this.hookBase, hookToken: g.hookToken, agents: this.agents, record: (s, k, a, p) => this.record(s, k, a, p) });
    this.workers.on('idle', () => this.emit('summary'));
  }

  private get hookBase(): string {
    return `${this.g.hookBase}/${this.name}`;
  }

  // ---------- state for the browser ----------

  summary(): ProjectSummary {
    return {
      name: this.name,
      live: this.session.running,
      busy: this.status.busy,
      waiting: this.permissions.list().length,
      running: this.agents.list().filter((a) => !a.endedAt && a.status !== 'idle').length,
      sessionName: this.store.getMeta('sessionName'),
    };
  }

  sessionState() {
    const { login, rateLimits, claude } = this.g.account();
    return {
      project: this.dir,
      projectName: this.name,
      running: this.session.running,
      busy: this.status.busy,
      sessionId: this.session.sessionId ?? this.store.getMeta('sessionId'),
      steerMode: this.agents.steerMode,
      login,
      apiKeySource: this.status.apiKeySource,
      model: this.status.model,
      rateLimits,
      claude,
      phone: this.g.notifier.enabled && !this.g.notifier.muted && this.rules.phone,
      maxRunning: this.rules.maxRunning,
      agentTypes: this.status.agentTypes,
      mainModel: this.rules.mainModel,
      sessionName: this.store.getMeta('sessionName'),
      rules: this.rules,
      defaults: this.rulesStore.defaults(),
      wikis: this.g.wikis.list(),
    };
  }

  hello(): object {
    return {
      type: 'hello',
      session: this.sessionState(),
      agents: this.agents.list(),
      approvals: this.permissions.list(),
      rules: this.permissions.rules(),
      events: this.store.recent(1500),
      git: this.git.state,
    };
  }

  broadcastSession(): void {
    this.emit('message', { type: 'session', session: this.sessionState() });
  }

  // ---------- events ----------

  private record(source: EventSource, kind: string, agentId: string | null, payload: unknown): void {
    const event = this.store.append({ source, kind, agentId, sessionId: this.session?.sessionId ?? null, payload });
    this.emit('message', { type: 'event', event });
    // Any finished tool call or turn may have changed files.
    if ((source === 'hook' && kind === 'PostToolUse') || (source === 'stream' && kind.startsWith('result'))) this.git?.poke();
  }

  private forgeRecord(kind: string, agentId: string | null, payload: unknown): void {
    this.record('forge', kind, agentId, payload);
  }

  private who(agentId: string | null): string {
    return agentId ? (this.agents.list().find((a) => a.agentId === agentId)?.description ?? 'A subagent') : 'Claude';
  }

  private eventsSinceReset() {
    const history = this.store.recent(20_000);
    return history.slice(history.findLastIndex((e) => e.kind === 'session.reset') + 1);
  }

  /** After a restart: rebuild the subagents of the current session and close approvals nobody can answer now. */
  private recover(): void {
    const history = this.store.recent(20_000);
    this.agents.replay(history.slice(history.findLastIndex((e) => e.kind === 'session.reset') + 1));
    const decided = new Set(history.filter((e) => e.kind === 'approval.decided').map((e) => e.payload.id));
    for (const e of history) {
      if (e.kind !== 'approval.requested' || decided.has(e.payload.id)) continue;
      this.store.append({ source: 'forge', kind: 'approval.decided', agentId: e.agentId, sessionId: e.sessionId, payload: { id: e.payload.id, decision: 'deny', by: 'reset', note: 'Forge AIOS restarted before this was answered.' } });
    }
  }

  // ---------- rules ----------

  /** Puts the session rules into effect everywhere they matter. Model and wiki changes also need restartSession(). */
  private applyRules(): void {
    this.agents.maxRunning = this.rules.maxRunning;
    this.agents.modelLimits = this.rules.maxByModel;
    this.agents.mainModel = this.rules.mainModel ?? modelAlias(this.status.model);
    this.permissions.autoAllowReadOnly = this.rules.autoAllowReadOnly;
    this.permissions.level = this.rules.approvals;
    this.permissions.readOnlyDirs = this.rules.wikis.map((id) => this.g.wikis.pathOf(id));
  }

  private linkedWikis() {
    return this.g.wikis.list().filter((w) => this.rules.wikis.includes(w.id));
  }

  /** Tells the main session about its linked wikis and how to use them. */
  private wikiPrompt(): string {
    const linked = this.linkedWikis();
    if (!linked.length) return '';
    return (
      `\n\nLinked context wikis (read only; never change them): ${linked.map((w) => `"${w.name}" at ${w.path}`).join(', ')}. ` +
      `When you need background on their subject, read the wiki's wiki/index.md first, then open the relevant pages and follow links, ` +
      `as the QUERY rules in its CLAUDE.md describe. Cite the pages you used.`
    );
  }

  /** Changes the session's rules: validated, saved, applied, and the CLI restarted if the model or wikis changed. */
  async updateRules(raw: Partial<Rules>): Promise<void> {
    const before = this.rules;
    this.rules = { ...this.rules, ...sanitize(raw, this.g.wikis.ids()) };
    this.rulesStore.setSession(this.rules);
    this.applyRules();
    this.broadcastSession();
    const added = this.rules.wikis.filter((id) => !before.wikis.includes(id));
    const wikisChanged = added.length > 0 || before.wikis.some((id) => !this.rules.wikis.includes(id));
    if (before.mainModel !== this.rules.mainModel || wikisChanged) {
      await Promise.all(added.map((id) => this.g.wikis.pull(id)));
      this.restartSession();
    }
  }

  // ---------- the main session ----------

  private newSession(resume: string | null): Session {
    const s = new Session({
      cwd: this.dir,
      hookUrl: this.hookBase,
      hookToken: this.g.hookToken,
      allowedTools: this.g.allowedTools,
      systemPrompt: mainSystemPrompt(this.agents.trustTag) + this.wikiPrompt(),
      resume,
      model: this.rules.mainModel ?? undefined,
      addDirs: this.linkedWikis().map((w) => w.path),
      name: this.store.getMeta('sessionName') ?? undefined,
    });
    // A replaced session (after "New session") may still be finishing its turn; nothing it says belongs to the new one.
    s.on('message', (m: Record<string, any>) => s === this.session && this.onStream(m));
    s.on('stderr', (line: string) => s === this.session && this.forgeRecord('session.stderr', null, { line }));
    s.on('exit', (info) => {
      // A process replaced or parked on purpose ending is expected, not an error to show.
      if (s !== this.session) return this.forgeRecord('session.replaced', null, info);
      if (this.parking) {
        this.parking = false;
        this.forgeRecord('session.parked', null, info);
      } else {
        this.forgeRecord('session.exited', null, info);
      }
      this.status.busy = false;
      this.permissions.denyAll('reset', 'The session ended.');
      this.broadcastSession();
      this.emit('summary');
    });
    return s;
  }

  private onStream(m: Record<string, any>): void {
    // Token-by-token text for the main session's live reply: shown, not stored (the final message is).
    if (m.type === 'stream_event') {
      if (!m.parent_tool_use_id) this.emit('message', { type: 'delta', event: m.event });
      return;
    }
    // The CLI starts turns of its own (e.g. when a background subagent reports back); main is busy then too.
    if (!this.status.busy && !m.parent_tool_use_id && (m.type === 'assistant' || (m.type === 'system' && m.subtype === 'init'))) {
      this.startTurn();
      this.broadcastSession();
    }
    this.agents.onStream(m);
    this.record('stream', streamKind(m), this.agents.agentFor(m), m);
    if (m.type === 'system' && m.subtype === 'init') {
      this.status.apiKeySource = m.apiKeySource ?? null;
      this.status.model = m.model ?? null;
      this.applyRules(); // subagents inherit main's model; now it's known
      if (Array.isArray(m.agents)) this.status.agentTypes = m.agents.filter((a: unknown) => typeof a === 'string');
      this.store.setMeta('sessionId', m.session_id);
      this.broadcastSession();
    }
    if (m.type === 'rate_limit_event') {
      this.g.setRateLimits(m.rate_limit_info);
    }
    if (m.type === 'result') this.onTurnEnd(m);
  }

  private onTurnEnd(m: Record<string, any>): void {
    const took = Date.now() - this.status.turnStartedAt;
    // Anything typed while Claude was busy that no tool call picked up goes out now, as the next message.
    const notes = this.agents.takeNotes(null);
    if (notes.length) {
      this.startTurn();
      this.session.send(notes.map((n) => n.text).join('\n\n'));
    } else {
      this.status.busy = false;
      if (this.pendingRestart) this.restartSession();
      this.schedulePark();
    }
    if (this.rules.phone && (m.is_error || took > this.rules.finishedPushAfterMin * 60_000)) {
      this.g.notifier.finished(`${this.name} ${m.is_error ? 'failed' : 'finished'}`, String(m.result ?? (m.is_error ? 'Session failed' : 'Turn finished')), !!m.is_error);
    }
    this.broadcastSession();
    this.emit('summary');
  }

  private startTurn(): void {
    this.status.busy = true;
    this.status.turnStartedAt = Date.now();
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = null;
    this.emit('summary');
  }

  /** An idle session gives its process back after a while; the next message resumes the same conversation. */
  private schedulePark(): void {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = setTimeout(() => {
      this.parkTimer = null;
      const working = this.agents.list().some((a) => !a.endedAt && a.status !== 'idle');
      if (this.status.busy || working || !this.session.running) return;
      this.parking = true;
      this.session.close();
    }, PARK_MS);
    this.parkTimer.unref();
  }

  /** Restarts the CLI on the same conversation, so new rules (main model, linked wikis) take effect. Waits for a running turn. */
  private restartSession(): void {
    if (this.status.busy) {
      this.pendingRestart = true;
      return;
    }
    this.pendingRestart = false;
    const resume = this.session.sessionId ?? this.store.getMeta('sessionId');
    this.session.stop();
    this.session = this.newSession(resume);
    this.forgeRecord('session.restarted', null, { reason: 'rules' });
    this.broadcastSession();
  }

  /** What goes to the CLI for a message you typed: Forge's pending context for main, then your words. */
  private withContext(text: string): string {
    const notes = this.agents.takeInternalMainNotes();
    if (!notes.length) return text;
    // Tagged like every other note, or main rightly treats it as possibly forged (gate-extras finding).
    return `${steerHeader(this.agents.trustTag)}\n${notes.map((n) => `- ${n.text}`).join('\n')}\n\n${text}`;
  }

  // ---------- agents and wikis ----------

  /** Add agent: a worker of its own, or a subagent the main session launches with exactly this spec. */
  private addAgent(raw: Partial<AddAgentRequest>): void {
    const r: AddAgentRequest = {
      name: String(raw.name ?? '').trim().slice(0, 60) || 'Agent',
      model: MODEL_IDS.has(String(raw.model)) ? String(raw.model) : '',
      task: String(raw.task ?? '').trim(),
      mode: raw.mode === 'main' ? 'main' : 'worker',
      agentType: raw.agentType && this.status.agentTypes.includes(raw.agentType) ? raw.agentType : undefined,
    };
    if (!r.task) return;
    if (r.mode === 'worker' && !r.model) r.model = this.rules.workerModel;
    const refusal = this.agents.capRefusal(r.mode === 'worker' ? r.model : r.model || this.agents.mainModel);
    if (refusal) {
      this.forgeRecord('agent.refused', null, { name: r.name, reason: refusal });
      return;
    }
    if (r.mode === 'worker') {
      this.workers.start(r, { addDirs: this.linkedWikis().map((w) => w.path) });
      return;
    }
    // The hook swaps in the user's exact task, model and type when main launches it (agents.ts preToolUse).
    this.agents.requestFromMain(r);
    this.forgeRecord('agent.requested', null, r);
    const text =
      `Launch one subagent now with the Agent tool, with the description "${r.name}" and any short prompt: ` +
      `Forge AIOS replaces the prompt, model and type with the ones I set, so don't write a task for it. When it reports back, tell me what it found.`;
    if (this.status.busy) {
      this.agents.queueNote(null, text);
    } else {
      this.startTurn();
      this.session.send(text);
    }
    this.broadcastSession();
  }

  private async addWiki(repo: string): Promise<void> {
    try {
      const id = await this.g.wikis.add(repo.trim());
      this.forgeRecord('wiki.added', null, { id, repo });
      if (!this.rules.wikis.includes(id)) await this.updateRules({ wikis: [...this.rules.wikis, id] });
    } catch (err) {
      this.forgeRecord('wiki.error', null, { name: repo, message: errText(err) });
    }
  }

  /** Create from this session: scaffold a wiki, export this session as its first source, let a worker ingest it, publish, link. */
  private async createWiki(raw: { name?: string; subject?: string; publish?: boolean }): Promise<void> {
    const { wikis } = this.g;
    const name = String(raw.name ?? '').trim().slice(0, 60);
    if (!name) return;
    const sessionName = this.store.getMeta('sessionName') ?? 'Untitled session';
    const date = new Date().toISOString().slice(0, 10);
    const source = sessionTranscript(this.eventsSinceReset(), this.agents.list(), { name: sessionName, project: this.dir, model: this.status.model });
    const id = wikis.scaffold(name, String(raw.subject ?? ''), `${date}-session-${slug(sessionName)}.md`, source);
    const dir = wikis.pathOf(id);
    const fail = (err: unknown) => {
      wikis.set(id, { status: 'error', detail: errText(err) });
      this.forgeRecord('wiki.error', null, { id, name, message: errText(err) });
    };
    try {
      await wikis.initRepo(id);
      wikis.set(id, { detail: 'Ingesting this session…' });
      const task =
        'You are building a new context wiki in this folder for the user. Read CLAUDE.md first. ' +
        "Ingest the session record in raw/inbox/ following the INGEST steps in batch mode (don't ask about emphasis), with one change: " +
        `don't push. Forge AIOS creates the GitHub repo and pushes when you finish. Commit with: git add -A && git commit -m "ingest: ${slug(sessionName)}". ` +
        'Then reply with a short list of the pages you created.';
      const workerId = this.workers.start({ name: `Wiki builder: ${name}`, model: this.rules.workerModel, mode: 'worker', task }, { cwd: dir });
      this.permissions.builders.set(workerId, dir);
      this.forgeRecord('wiki.building', null, { id, name, workerId });
      const finish = async (wid: string, exited: boolean) => {
        if (wid !== workerId) return;
        this.workers.off('idle', onIdle);
        this.workers.off('exited', onExit);
        this.permissions.builders.delete(workerId);
        try {
          if (exited) throw new Error('The wiki builder stopped before it finished.');
          this.workers.close(workerId);
          await wikis.commitAll(id, `ingest: ${slug(sessionName)}`);
          if (raw.publish !== false) {
            wikis.set(id, { detail: 'Publishing to GitHub…' });
            await wikis.publish(id);
          }
          wikis.done(id);
          this.forgeRecord('wiki.created', null, { id, name, published: raw.publish !== false });
          await this.updateRules({ wikis: [...this.rules.wikis, id] });
        } catch (err) {
          fail(err);
        }
      };
      const onIdle = (wid: string) => finish(wid, false);
      const onExit = (wid: string) => finish(wid, true);
      this.workers.on('idle', onIdle);
      this.workers.on('exited', onExit);
    } catch (err) {
      fail(err);
    }
  }

  // ---------- the browser ----------

  onClient(msg: ClientMessage): void {
    const { agents, permissions, workers, store } = this;
    switch (msg.type) {
      case 'send': {
        const text = String(msg.text ?? '').trim();
        if (!text) return;
        if (this.status.busy) {
          // Mid-turn: reaches Claude at its next tool call, or as the next message when the turn ends.
          const note = agents.queueNote(null, text);
          this.forgeRecord('user.message', null, { text, queuedNoteId: note?.id ?? null });
        } else {
          this.forgeRecord('user.message', null, { text });
          this.startTurn();
          this.session.send(this.withContext(text));
        }
        this.broadcastSession();
        this.emit('summary');
        break;
      }
      case 'interrupt':
        if (!this.session.interrupt()) return;
        this.forgeRecord('session.interrupted', null, {});
        permissions.denyAll('interrupt', 'The user interrupted the session.');
        break;
      case 'decide':
        permissions.decide(String(msg.id), msg.decision, msg.note ? String(msg.note) : undefined);
        break;
      case 'steer':
        // To a worker, a message starts its next turn if it's idle; to anything else it's a note for its next step.
        if (msg.agentId && workers.has(msg.agentId)) workers.message(msg.agentId, String(msg.text));
        else agents.queueNote(msg.agentId ?? null, String(msg.text));
        break;
      case 'addAgent':
        this.addAgent(msg.request ?? {});
        break;
      case 'closeAgent':
        workers.close(String(msg.agentId));
        break;
      case 'stop':
        agents.requestStop(String(msg.agentId));
        break;
      case 'config':
        if (msg.steerMode === 'context' || msg.steerMode === 'deny') agents.steerMode = msg.steerMode;
        if (typeof msg.phoneMuted === 'boolean') this.g.notifier.muted = msg.phoneMuted;
        if ('maxRunning' in msg) this.updateRules({ maxRunning: msg.maxRunning ?? null });
        this.broadcastSession();
        break;
      case 'setRules':
        this.updateRules(msg.rules ?? {});
        break;
      case 'setDefaults':
        this.rulesStore.setDefaults(sanitize(msg.rules ?? {}, this.g.wikis.ids()));
        this.broadcastSession();
        break;
      case 'removeRule':
        permissions.removeRule(String(msg.key));
        break;
      case 'wikiAdd':
        this.addWiki(String(msg.repo ?? ''));
        break;
      case 'wikiCreate':
        this.createWiki(msg);
        break;
      case 'wikiRemove':
        this.g.wikis.remove(String(msg.id));
        break;
      case 'nameSession':
        store.setMeta('sessionName', String(msg.name ?? '').trim().slice(0, 80) || null);
        this.broadcastSession();
        this.emit('summary');
        break;
      case 'reset':
        permissions.denyAll('reset', 'The user started a new session.');
        permissions.clearRules();
        store.setMeta('sessionId', null);
        // A new session starts from the defaults, with the model and name chosen for it.
        this.rules = {
          ...this.rulesStore.defaults(),
          ...(msg.model !== undefined && { mainModel: MODEL_IDS.has(String(msg.model)) ? String(msg.model) : null }),
          ...(APPROVAL_LEVELS.some((l) => l.id === msg.approvals) && { approvals: msg.approvals }),
        };
        this.rules.wikis = this.rules.wikis.filter((id) => this.g.wikis.ids().has(id));
        this.rulesStore.setSession(this.rules);
        this.applyRules();
        for (const id of this.rules.wikis) this.g.wikis.pull(id);
        store.setMeta('sessionName', String(msg.name ?? '').trim().slice(0, 80) || null);
        workers.closeAll();
        this.session.stop();
        agents.reset(); // new trust tag first: the new session's system prompt carries it
        this.session = this.newSession(null);
        this.status.busy = false;
        this.forgeRecord('session.reset', null, {});
        this.broadcastSession();
        this.emit('summary');
        break;
    }
  }

  /** A hook call from this project's CLI (main session or a worker): steering first, then the permission decision. */
  async onHook(res: http.ServerResponse, event: string, workerId: string | null, body: Record<string, any>): Promise<HookResponse | null> {
    if (workerId && !this.workers.has(workerId)) return null;
    // A worker's own calls carry no agent_id (it's a main session to the CLI); file them under the worker.
    if (workerId && typeof body.agent_id !== 'string') body.agent_id = workerId;
    const agentId = typeof body.agent_id === 'string' ? body.agent_id : null;
    let response: HookResponse = this.agents.onHook(event, body);
    // A turn is starting (yours, or one the CLI starts itself when a background subagent reports back): Forge's
    // pending notes for main ride along, tagged, so main knows what you told its subagents before it summarises.
    if (event === 'UserPromptSubmit' && !workerId) {
      const notes = this.agents.takeInternalMainNotes();
      if (notes.length) {
        const text = `${steerHeader(this.agents.trustTag)}\n${notes.map((n) => `- ${n.text}`).join('\n')}`;
        response = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
      }
    }

    if (event === 'PreToolUse' && !isDenied(response)) {
      const cancelled = new AbortController();
      res.on('close', () => cancelled.abort()); // the CLI gave up on this call (interrupt, exit)
      const verdict = await this.permissions.check(agentId, String(body.tool_name), body.tool_input ?? {}, body.tool_use_id, cancelled.signal);
      if (verdict.decision === 'deny') this.agents.clearCurrent(agentId);
      // Tagged like steering notes, so a deny note from the user is trusted as the user's words.
      const reason = verdict.reason && `${steerHeader(this.agents.trustTag)}\n${verdict.reason}`;
      response = {
        ...response,
        hookSpecificOutput: {
          ...((response.hookSpecificOutput as object | undefined) ?? {}),
          hookEventName: 'PreToolUse',
          permissionDecision: verdict.decision,
          ...(reason && { permissionDecisionReason: reason }),
        },
      };
    }
    this.record('hook', event, agentId, { body, response });
    return response;
  }

  /** A wiki was removed from the server: stop linking it (restarting Claude if it was linked). */
  unlinkWiki(id: string): void {
    if (this.rules.wikis.includes(id)) this.updateRules({ wikis: this.rules.wikis.filter((w) => w !== id) });
    else this.broadcastSession();
  }

  /** Stops everything this project runs (server shutdown). */
  shutdown(): void {
    this.permissions.denyAll('reset', 'Forge AIOS is restarting.');
    this.workers.closeAll();
    this.session.stop();
  }

  /** True if this project has a log from an earlier run (so it should be loaded at startup). */
  static hasHistory(dataDir: string, name: string): boolean {
    return fs.existsSync(path.join(dataDir, `${name}.db`));
  }
}
