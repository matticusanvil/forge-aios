import { toolTarget } from '../../shared/text.ts';
import { modelLabel, type Approval, type ForgeEvent } from '../../shared/types.ts';

export type ApprovalState = { approval: Approval; decision?: { decision: string; by: string; note: string | null } };

export type ToolItem = {
  kind: 'tool';
  /** The approval this call needed, if any: shown on and under its row instead of as a separate item. */
  approval?: ApprovalState;
  id: string;
  name: string;
  target: string;
  input: Record<string, unknown>;
  at: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
};

export type ChatItem =
  | { kind: 'you'; id: string; at: string; text: string; queuedNoteId?: string; delivered?: boolean }
  | { kind: 'claude'; id: string; at: string; text: string }
  /** The task a subagent was given, as its first message. */
  | { kind: 'task'; id: string; at: string; text: string }
  | ToolItem
  | { kind: 'spawn'; id: string; at: string; description: string; subagentType: string; agentId?: string; model?: string; byYou?: boolean; refused?: boolean }
  | ({ kind: 'approval'; id: string; at: string } & ApprovalState)
  | { kind: 'turn'; id: string; at: string; durationMs: number; isError: boolean; text: string }
  | { kind: 'notice'; id: string; at: string; tone: 'warning' | 'error' | 'success'; cap: string; text: string };

const AGENT_TOOLS = new Set(['Agent', 'Task']);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
  return '';
}

/**
 * Rebuilds a conversation from the event log, in the order things happened.
 * scope null: the main session's chat. Subagents' own messages stay out of it, but their approvals appear, since they need the user.
 * scope = an agent id: that subagent's activity: its task, tool calls, messages, your notes to it, its approvals.
 */
export function buildChat(events: ForgeEvent[], scope: string | null = null): ChatItem[] {
  let items: ChatItem[] = [];
  const byId = new Map<string, ChatItem>();
  const approvals = new Map<string, ApprovalState>();
  const main = scope === null;
  const mine = (e: ForgeEvent) => (main ? !e.agentId : e.agentId === scope);
  const add = (item: ChatItem) => {
    items.push(item);
    byId.set(item.id, item);
  };

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.source === 'forge') {
      switch (e.kind) {
        case 'user.message':
          if (mine(e)) add({ kind: 'you', id: `you-${e.id}`, at: e.ts, text: p.text, queuedNoteId: p.queuedNoteId ?? undefined });
          break;
        case 'worker.started':
          if (main) add({ kind: 'spawn', id: `worker-${e.agentId}`, at: e.ts, description: p.name, subagentType: 'worker', agentId: e.agentId ?? undefined, model: p.model, byYou: true });
          else if (e.agentId === scope) add({ kind: 'task', id: `task-${e.id}`, at: e.ts, text: p.task });
          break;
        case 'worker.closed':
        case 'worker.exited':
          if (!main && e.agentId === scope && !items.some((i) => i.id === `closed-${scope}`)) {
            add({ kind: 'notice', id: `closed-${scope}`, at: e.ts, tone: 'success', cap: 'Closed', text: 'This agent was closed.' });
          }
          break;
        case 'agent.requested':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'success', cap: 'Add agent', text: `Asked Claude to launch "${p.name}"${p.model ? ` on ${modelLabel(p.model)}` : ''}. It reports back to the main session.` });
          break;
        case 'agent.refused':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'warning', cap: 'Limit', text: `Didn't add "${p.name}": ${p.reason ?? `${p.limit} agents are already running.`} Change the limits on the Rules page, or wait for one to finish.` });
          break;
        case 'session.restarted':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'success', cap: 'Restarted', text: 'Claude restarted on the same conversation, so the new rules (model or linked wikis) apply.' });
          break;
        case 'wiki.added':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'success', cap: 'Wiki', text: `Added and linked the "${p.id}" wiki (read only).` });
          break;
        case 'wiki.building':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'success', cap: 'Wiki', text: `Building the "${p.name}" wiki from this session. A worker is ingesting it.` });
          break;
        case 'wiki.created':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'success', cap: 'Wiki', text: `The "${p.name}" wiki is ready${p.published ? ', pushed to a new private GitHub repo,' : ''} and linked to this session.` });
          break;
        case 'wiki.error':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'error', cap: 'Wiki', text: `"${p.name ?? p.id}": ${p.message}` });
          break;
        case 'spawn.refused': {
          const item = byId.get(p.toolUseId);
          if (item?.kind === 'spawn') item.refused = true;
          break;
        }
        case 'agent.requested.spawned': {
          const item = byId.get(p.toolUseId);
          if (item?.kind === 'spawn') Object.assign(item, { description: p.name, model: p.model || undefined, byYou: true });
          break;
        }
        case 'steer.queued':
          // Main-session notes already show as the message the user typed.
          if (!main && e.agentId === scope && !p.internal) add({ kind: 'you', id: `note-${p.id}`, at: e.ts, text: p.text, queuedNoteId: p.id });
          break;
        case 'steer.delivered':
          if (mine(e)) for (const item of items) if (item.kind === 'you' && item.queuedNoteId && p.noteIds?.includes(item.queuedNoteId)) item.delivered = true;
          break;
        case 'stop.requested':
          if (!main && e.agentId === scope) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'warning', cap: 'Stop', text: 'You asked it to stop. It finishes its current step, then reports back.' });
          break;
        case 'approval.requested': {
          if (!main && e.agentId !== scope) break;
          // One object per approval, shared by whatever shows it, so the decision lands on what's on screen.
          const tool = p.toolUseId ? byId.get(p.toolUseId) : undefined;
          if (tool?.kind === 'tool') {
            tool.approval = { approval: p };
            approvals.set(p.id, tool.approval);
          } else {
            const item: ChatItem & ApprovalState = { kind: 'approval', id: `approval-${p.id}`, at: e.ts, approval: p };
            add(item);
            approvals.set(p.id, item);
          }
          break;
        }
        case 'approval.decided': {
          const state = approvals.get(p.id);
          if (state) state.decision = { decision: p.decision, by: p.by, note: p.note };
          break;
        }
        case 'session.interrupted':
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'warning', cap: 'Interrupted', text: 'You interrupted the session.' });
          break;
        case 'session.reset':
          items = [];
          byId.clear();
          approvals.clear();
          if (main) add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'success', cap: 'New session', text: 'Started a new session. Claude has no memory of the previous one.' });
          break;
        case 'session.exited':
          if (main && p.code && p.signal !== 'SIGTERM') {
            add({ kind: 'notice', id: `n-${e.id}`, at: e.ts, tone: 'error', cap: 'Error', text: `The Claude process exited with code ${p.code}. Send a message to restart it.` });
          }
          break;
      }
      continue;
    }

    if (e.source === 'hook') {
      // The CLI reports how long each tool took.
      if (e.kind === 'PostToolUse' && mine(e)) {
        const item = byId.get(p.body?.tool_use_id);
        if (item?.kind === 'tool' && typeof p.body?.duration_ms === 'number') item.durationMs = p.body.duration_ms;
      }
      continue;
    }

    // A subagent's lifecycle messages carry its own id, but they belong to whoever spawned it.
    if (e.kind === 'system/task_started') {
      const item = byId.get(p.tool_use_id);
      if (item?.kind === 'spawn') item.agentId = p.task_id;
      // Forge appends a trust paragraph to every task (agents.ts); it's plumbing, not part of what was asked.
      if (!main && p.task_id === scope && p.prompt) add({ kind: 'task', id: `task-${e.id}`, at: e.ts, text: String(p.prompt).split('\n\n(Added by Forge AIOS')[0] });
      continue;
    }
    if (e.kind === 'system/task_notification' && !main && e.agentId === scope) {
      add({ kind: 'turn', id: `turn-${e.id}`, at: e.ts, durationMs: p.usage?.duration_ms ?? 0, isError: p.status === 'failed', text: p.status === 'failed' ? String(p.summary ?? 'It failed.') : '' });
      continue;
    }
    if (!mine(e)) continue;

    if (e.kind === 'assistant') {
      for (const b of p.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) {
          const last = items.at(-1);
          const key = `claude-${p.message.id}`;
          if (last?.kind === 'claude' && last.id === key) last.text += `\n\n${b.text}`;
          else add({ kind: 'claude', id: key, at: e.ts, text: b.text });
        } else if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
          add({ kind: 'spawn', id: b.id, at: e.ts, description: b.input?.description ?? 'Subagent', subagentType: b.input?.subagent_type ?? 'general-purpose', model: b.input?.model });
        } else if (b.type === 'tool_use') {
          const tool: ToolItem = { kind: 'tool', id: b.id, name: b.name, target: toolTarget(b.input), input: b.input ?? {}, at: e.ts };
          // If its approval was logged first, move it onto the row.
          const early = items.findIndex((x) => x.kind === 'approval' && x.approval.toolUseId === b.id);
          if (early !== -1) {
            const [x] = items.splice(early, 1);
            if (x.kind === 'approval') tool.approval = approvals.get(x.approval.id);
          }
          add(tool);
        }
      }
    } else if (e.kind === 'user') {
      const content = p.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        const item = byId.get(b.tool_use_id);
        if (item?.kind === 'tool') {
          item.result = resultText(b.content);
          item.isError = !!b.is_error;
        }
      }
    } else if (e.kind.startsWith('result')) {
      add({ kind: 'turn', id: `turn-${e.id}`, at: e.ts, durationMs: p.duration_ms ?? 0, isError: !!p.is_error, text: p.is_error ? String(p.result ?? p.subtype ?? 'The turn failed.') : '' });
    }
  }
  return items;
}

const timeFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Toronto local, 24-hour: "14:02". */
export const clock = (iso: string) => timeFormat.format(new Date(iso));

export function duration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Subagents take the agent palette in spawn order; the main session is always gold.
const PALETTE = ['teal', 'ice', 'lilac', 'peach', 'lime', 'rose', 'cloud'] as const;
export const agentColor = (index: number) => `var(--agent-${PALETTE[index % PALETTE.length]})`;
