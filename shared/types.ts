// Shapes that cross the WebSocket, used by both the server and the browser.

export type EventSource = 'stream' | 'hook' | 'forge';

export type ForgeEvent = {
  id: number;
  ts: string;
  source: EventSource;
  kind: string;
  sessionId: string | null;
  agentId: string | null;
  payload: any;
};

/** `internal` notes come from Forge itself (e.g. "don't relaunch a stopped subagent"), not from something the user typed. */
export type Note = { id: string; text: string; status: 'queued' | 'delivered'; queuedAt: string; deliveredAt?: string; internal?: boolean };

/** `idle`: a worker waiting for your next message. */
export type AgentStatus = 'running' | 'idle' | 'stopping' | 'stopped' | 'done' | 'failed';

/** The models you can pick for an agent; the CLI maps each alias to the current model. */
export const MODELS = [
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'haiku', label: 'Haiku 5.5' },
  { id: 'fable', label: 'Fable 5.1' },
] as const;

/** Model alias for a model id or alias ("claude-opus-5-5" → "opus"); null if unknown. */
export const modelAlias = (id: string | null | undefined): string | null => MODELS.find((m) => m.id === id || id?.includes(`-${m.id}-`))?.id ?? null;

export const modelLabel = (id: string | undefined) => MODELS.find((m) => m.id === id || id?.includes(`-${m.id}-`))?.label ?? id;

/** An agent you add by hand: a worker on its own, or a subagent the main session launches for you. */
export type AddAgentRequest = { name: string; model: string; task: string; mode: 'worker' | 'main'; agentType?: string };

export type Agent = {
  agentId: string;
  /** A subagent launched by a session, or a worker: its own Claude process that you started and talk to directly. */
  kind?: 'subagent' | 'worker';
  /** Added by you with Add agent, not launched on Claude's own initiative. */
  manual?: boolean;
  /** Model alias or id; absent means the same model as whoever launched it. */
  model?: string;
  agentType?: string;
  toolUseId?: string;
  description?: string;
  status: AgentStatus;
  /** The CLI's own description of what it's doing ("Reading README.md"), from task_progress. */
  currentAction?: string;
  /** The tool call in flight, from the PreToolUse hook; cleared when it finishes. */
  current?: { tool: string; target: string; since: string };
  lastTool?: string;
  /** Set for a subagent launched by another subagent. */
  parentId?: string;
  tokens?: number;
  toolUses?: number;
  summary?: string;
  stopRequested: boolean;
  notes: Note[];
  startedAt: string;
  endedAt?: string;
};

export type Approval = {
  id: string;
  agentId: string | null;
  /** The tool call this approval is for, so the chat can show the answer on that call's row. */
  toolUseId?: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  why: string;
  /** What "Allow for session" would remember, e.g. "npm test …" or "all file edits". */
  ruleLabel: string;
  requestedAt: string;
};

export type Rule = { key: string; label: string };

export type RateWindow = { utilization: number; resetsAt: number };

/** The settings a session runs under. Every session starts from the defaults; any rule can be changed for the session. */
export type Rules = {
  /** Model alias for the main session; null = the CLI's default. */
  mainModel: string | null;
  /** Model new workers start on (Add agent). */
  workerModel: string;
  /** Most agents working at once; null = no limit. */
  maxRunning: number | null;
  /** Most agents on each model working at once (alias → limit); a missing or null entry = no limit. */
  maxByModel: Record<string, number | null>;
  /** Read, Glob, Grep and the like run without asking. */
  autoAllowReadOnly: boolean;
  /** How much runs without asking: see APPROVAL_LEVELS. */
  approvals: ApprovalLevel;
  /** Push approvals (and long-turn "finished" notices) to the phone. */
  phone: boolean;
  /** A turn longer than this many minutes gets a "finished" push. */
  finishedPushAfterMin: number;
  /** Ids of the context wikis linked to the session (read only). */
  wikis: string[];
};

export type ApprovalLevel = 'ask' | 'project' | 'all';

export const APPROVAL_LEVELS: { id: ApprovalLevel; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Every edit and shell command asks, until you allow it for the session.' },
  { id: 'project', label: 'Trusted project', hint: 'Edits inside the project, look-around commands (ls, cat, git status…) and build, test and commit commands run without asking. Pushes, deletes, network and anything outside the project still ask.' },
  { id: 'all', label: 'Allow everything', hint: 'Nothing asks, except edits to linked knowledge graphs, which stay refused.' },
];

export const DEFAULT_RULES: Rules = {
  mainModel: null,
  workerModel: 'sonnet',
  maxRunning: null,
  maxByModel: {},
  autoAllowReadOnly: true,
  approvals: 'project',
  phone: true,
  finishedPushAfterMin: 2,
  wikis: [],
};

/** A context wiki on the server: a git repo with CLAUDE.md rules and wiki/ pages (the knowledge-graph layout). */
export type WikiInfo = {
  id: string;
  name: string;
  path: string;
  remote: string | null;
  status: 'ready' | 'working' | 'error';
  /** What it's doing ("Cloning…", "Ingesting this session…") or what went wrong. */
  detail?: string;
  pages?: number;
};

export type SessionState = {
  project: string;
  projectName: string;
  running: boolean;
  busy: boolean;
  sessionId: string | null;
  steerMode: 'context' | 'deny';
  /** Most agents allowed to run at once; null = no limit. */
  maxRunning: number | null;
  /** Subagent types this session can launch, from the CLI's init message. */
  agentTypes: string[];
  /** Model alias chosen for the main session; null = the CLI's default. */
  mainModel: string | null;
  sessionName: string | null;
  rules: Rules;
  defaults: Rules;
  wikis: WikiInfo[];
  login: { loggedIn: boolean; method: string; plan: string | null } | null;
  apiKeySource: string | null;
  model: string | null;
  rateLimits: { unifiedWindows?: Record<string, RateWindow> } | null;
  phone: boolean;
};

/** Uncommitted changes in the project, against HEAD. */
export type GitState = {
  branch: string | null;
  files: { file: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; added: number | null; removed: number | null }[];
  error?: string;
};

/** One project's row in the sidebar and the projects overview. */
export type ProjectSummary = { name: string; live: boolean; busy: boolean; waiting: number; running: number; sessionName: string | null };

export type ServerMessage =
  | { type: 'hello'; session: SessionState; agents: Agent[]; approvals: Approval[]; rules: Rule[]; events: ForgeEvent[]; git: GitState }
  | { type: 'git'; git: GitState }
  | { type: 'projects'; projects: ProjectSummary[] }
  | { type: 'projectResult'; ok: boolean; name?: string; error?: string }
  | { type: 'event'; event: ForgeEvent }
  | { type: 'agents'; agents: Agent[] }
  | { type: 'approvals'; approvals: Approval[]; rules: Rule[] }
  | { type: 'session'; session: SessionState }
  | { type: 'delta'; event: any }
  | { type: 'error'; error: string };
