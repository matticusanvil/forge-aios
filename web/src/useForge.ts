import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AddAgentRequest, Agent, Approval, ApprovalLevel, ForgeEvent, GitState, ProjectSummary, Rule, Rules, ServerMessage, SessionState } from '../../shared/types.ts';

export type ForgeState = {
  connected: boolean;
  session: SessionState | null;
  agents: Agent[];
  approvals: Approval[];
  rules: Rule[];
  events: ForgeEvent[];
  git: GitState | null;
  /** Every project, for the sidebar and the overview. */
  projects: ProjectSummary[];
  /** The answer to the last clone or create, numbered so the same answer twice still registers. */
  projectResult: { ok: boolean; name?: string; error?: string; n: number } | null;
  /** The main session's reply as it streams in, before the finished message arrives. */
  live: string;
};

export type ClientMessage =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'decide'; id: string; decision: 'allow' | 'deny' | 'allow-session'; note?: string }
  | { type: 'steer'; agentId: string | null; text: string }
  | { type: 'stop'; agentId: string }
  | { type: 'addAgent'; request: AddAgentRequest }
  | { type: 'closeAgent'; agentId: string }
  | { type: 'config'; maxRunning: number | null }
  | { type: 'setRules'; rules: Partial<Rules> }
  | { type: 'setDefaults'; rules: Partial<Rules> }
  | { type: 'removeRule'; key: string }
  | { type: 'wikiAdd'; repo: string }
  | { type: 'wikiCreate'; name: string; subject?: string }
  | { type: 'wikiRemove'; id: string }
  | { type: 'nameSession'; name: string }
  | { type: 'reset'; model?: string; name?: string; approvals?: ApprovalLevel }
  | { type: 'open'; project: string }
  | { type: 'projectClone'; repo: string }
  | { type: 'projectCreate'; name: string };

// Enough history for a long session; older events stay in the database.
const MAX_EVENTS = 4000;

type Action = ServerMessage | { type: 'connected'; connected: boolean } | { type: 'switching' };

const initial: ForgeState = { connected: false, session: null, agents: [], approvals: [], rules: [], events: [], git: null, projects: [], projectResult: null, live: '' };

/** True for a finished main-session message that contains text, which replaces the live preview. */
const endsLive = (e: ForgeEvent) =>
  e.source === 'stream' && !e.agentId && (e.kind.startsWith('result') || (e.kind === 'assistant' && e.payload?.message?.content?.some((b: any) => b.type === 'text')));

function reducer(state: ForgeState, action: Action): ForgeState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: action.connected };
    case 'switching':
      // Another project is opening: nothing of this one should linger while its hello is on the way.
      return { ...initial, connected: state.connected, projects: state.projects };
    case 'projects':
      return { ...state, projects: action.projects };
    case 'projectResult':
      return { ...state, projectResult: { ok: action.ok, name: action.name, error: action.error, n: (state.projectResult?.n ?? 0) + 1 } };
    case 'hello':
      return { ...state, session: action.session, agents: action.agents, approvals: action.approvals, rules: action.rules, events: action.events, git: action.git, live: '' };
    case 'event': {
      const events = state.events.length >= MAX_EVENTS ? [...state.events.slice(-MAX_EVENTS + 1), action.event] : [...state.events, action.event];
      return { ...state, events, live: endsLive(action.event) ? '' : state.live };
    }
    case 'agents':
      return { ...state, agents: action.agents };
    case 'approvals':
      return { ...state, approvals: action.approvals, rules: action.rules };
    case 'session':
      return { ...state, session: action.session };
    case 'git':
      return { ...state, git: action.git };
    case 'delta': {
      const e = action.event;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'text') return { ...state, live: '' };
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') return { ...state, live: state.live + e.delta.text };
      return state;
    }
    default:
      return state;
  }
}

/**
 * One WebSocket to the server: the open project's state, kept current, and a way to send to it. Reconnects on its own,
 * back to the same project. `project` null = the server's default (the first hello says which it is).
 */
export function useForge(project: string | null, onUnauthorized: () => void): [ForgeState, (msg: ClientMessage) => void] {
  const [state, dispatch] = useReducer(reducer, initial);
  const ws = useRef<WebSocket | null>(null);
  const current = useRef(project);

  // Switching projects: same socket, a new subscription.
  useEffect(() => {
    if (current.current === project) return;
    current.current = project;
    if (project && ws.current?.readyState === WebSocket.OPEN) {
      dispatch({ type: 'switching' });
      ws.current.send(JSON.stringify({ type: 'open', project }));
    }
  }, [project]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const query = current.current ? `?project=${encodeURIComponent(current.current)}` : '';
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${query}`);
      ws.current = socket;
      socket.onopen = () => dispatch({ type: 'connected', connected: true });
      socket.onmessage = (raw) => dispatch(JSON.parse(String(raw.data)) as ServerMessage);
      socket.onclose = (e) => {
        dispatch({ type: 'connected', connected: false });
        // Signed out (or the sign-in expired): back to the sign-in page instead of retrying.
        if (e.code === 4401) return onUnauthorized();
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  return [state, send];
}
