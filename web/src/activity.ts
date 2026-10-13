import { toolTarget } from '../../shared/text.ts';
import type { Agent, ForgeEvent, GitState } from '../../shared/types.ts';

/** One time an agent read or changed a file, from the CLI's PostToolUse hook (so only calls that actually ran). */
export type Touch = { path: string; agentId: string | null; kind: 'read' | 'write'; at: number; toolUseId: string; tool: string };

export type FileRow = {
  path: string;
  name: string;
  dir: string;
  /** Most recent toucher; undefined for a file only git reports as changed. */
  lastAgent?: string | null;
  lastAt?: number;
  /** 1 = minutes ago, 2 = within half an hour, 3 = earlier this session. */
  heat?: 1 | 2 | 3;
  touches: Touch[];
  git?: GitState['files'][number];
};

/** Something on the timeline that can be clicked back to the chat: a scope (null = main) and a chat item id. */
export type JumpTarget = { scope: string | null; id: string };

export type Tick = { at: number; tool: string; target: string; path?: string; jump: JumpTarget };
export type Mark = { at: number; kind: 'note' | 'approval' | 'allowed' | 'stop'; jump?: JumpTarget };
export type Lane = { agentId: string | null; name: string; ticks: Tick[]; marks: Mark[] };

const READS = new Set(['Read', 'NotebookRead']);
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Events since the last "New session": the activity view covers the current session only. */
export function sessionEvents(events: ForgeEvent[]): ForgeEvent[] {
  const reset = events.findLastIndex((e) => e.kind === 'session.reset');
  return reset === -1 ? events : events.slice(reset + 1);
}

/**
 * A path inside the project, relative to it, with / separators as git writes them; anything else stays absolute.
 * On Windows (a root like C:\\…) either slash works and case doesn't matter.
 */
export function projectPath(file: string, root: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(root);
  const norm = (p: string) => (windows ? p.replace(/\\/g, '/') : p);
  const f = norm(file);
  const base = `${norm(root).replace(/\/+$/, '')}/`;
  const inside = windows ? f.toLowerCase().startsWith(base.toLowerCase()) : f.startsWith(base);
  return inside ? f.slice(base.length) : f;
}

const filePathOf = (input: any): string | undefined => (typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : undefined);

export function touches(events: ForgeEvent[], root: string): Touch[] {
  const out: Touch[] = [];
  for (const e of events) {
    if (e.source !== 'hook' || e.kind !== 'PostToolUse') continue;
    const tool = e.payload?.body?.tool_name;
    const file = filePathOf(e.payload?.body?.tool_input);
    if (!file || !(READS.has(tool) || WRITES.has(tool))) continue;
    out.push({ path: projectPath(file, root), agentId: e.agentId, kind: WRITES.has(tool) ? 'write' : 'read', at: Date.parse(e.ts), toolUseId: e.payload.body.tool_use_id, tool });
  }
  return out;
}

const heatOf = (ageMs: number): 1 | 2 | 3 => (ageMs < 5 * 60_000 ? 1 : ageMs < 30 * 60_000 ? 2 : 3);

/** Every file touched this session or changed in git, newest information first per file; sorted by folder, then name. */
export function fileRows(all: Touch[], git: GitState | null, now: number): FileRow[] {
  const rows = new Map<string, FileRow>();
  const row = (p: string) => {
    let r = rows.get(p);
    if (!r) {
      const i = p.lastIndexOf('/');
      r = { path: p, name: i === -1 ? p : p.slice(i + 1), dir: i === -1 ? '' : p.slice(0, i), touches: [] };
      rows.set(p, r);
    }
    return r;
  };
  for (const t of all) {
    const r = row(t.path);
    r.touches.push(t);
    if (r.lastAt === undefined || t.at >= r.lastAt) Object.assign(r, { lastAt: t.at, lastAgent: t.agentId });
  }
  for (const g of git?.files ?? []) row(g.file).git = g;
  for (const r of rows.values()) if (r.lastAt !== undefined) r.heat = heatOf(now - r.lastAt);
  return [...rows.values()].sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
}

/**
 * One lane per agent, main first: a tick per tool call (from PreToolUse, so a call waiting for approval shows too),
 * and marks for your notes, approvals and stops. Every tick and most marks point back at the chat item for that moment.
 */
export function lanes(events: ForgeEvent[], agents: Agent[], root: string): Lane[] {
  const byAgent = new Map<string | null, Lane>([[null, { agentId: null, name: 'Claude', ticks: [], marks: [] }]]);
  for (const a of agents) byAgent.set(a.agentId, { agentId: a.agentId, name: a.description ?? a.agentType ?? 'Subagent', ticks: [], marks: [] });
  const lane = (id: string | null) => byAgent.get(id);
  // One pill per approval: APPROVAL while it waits, turned into ALLOWED (same jump) once allowed.
  const approvalMarks = new Map<string, Mark>();

  for (const e of events) {
    const at = Date.parse(e.ts);
    const p = e.payload ?? {};
    if (e.source === 'hook' && e.kind === 'PreToolUse') {
      const body = p.body ?? {};
      const file = filePathOf(body.tool_input);
      lane(e.agentId)?.ticks.push({
        at,
        tool: String(body.tool_name),
        target: toolTarget(body.tool_input),
        path: file && projectPath(file, root),
        jump: { scope: e.agentId, id: body.tool_use_id },
      });
    } else if (e.source === 'forge') {
      if (e.kind === 'steer.delivered' && p.mode !== 'with-message') {
        lane(e.agentId)?.marks.push({ at, kind: 'note', jump: e.agentId ? { scope: e.agentId, id: `note-${p.noteIds?.[0]}` } : undefined });
      } else if (e.kind === 'approval.requested') {
        const mark: Mark = { at, kind: 'approval', jump: p.toolUseId ? { scope: e.agentId, id: p.toolUseId } : { scope: e.agentId, id: `approval-${p.id}` } };
        lane(e.agentId)?.marks.push(mark);
        approvalMarks.set(p.id, mark);
      } else if (e.kind === 'approval.decided' && p.decision !== 'deny') {
        const mark = approvalMarks.get(p.id);
        if (mark) Object.assign(mark, { kind: 'allowed', at });
        else lane(e.agentId)?.marks.push({ at, kind: 'allowed' });
      } else if (e.kind === 'stop.requested') {
        lane(e.agentId)?.marks.push({ at, kind: 'stop' });
      }
    }
  }
  return [...byAgent.values()];
}
