import { useEffect, useMemo, useRef, useState } from 'react';
import { modelLabel, type AddAgentRequest, type Agent, type Approval, type ForgeEvent, type SessionState } from '../../../shared/types.ts';
import { plainText } from '../../../shared/text.ts';
import { buildChat, duration } from '../chat.ts';
import { useJump, type Jump } from '../jump.ts';
import { AddAgentForm } from './AddAgentForm.tsx';
import { ChatItems, type ChatContext } from './ChatItems.tsx';
import { StatusPill, type PillStatus } from './StatusPill.tsx';

type Props = {
  session: SessionState | null;
  agents: Agent[];
  events: ForgeEvent[];
  pending: Approval[];
  selected: string | null;
  colorOf: (agentId: string | undefined) => string | undefined;
  nameOf: (agentId: string | null) => string;
  onSelect: (agentId: string | null) => void;
  onSteer: (agentId: string, text: string) => void;
  onStop: (agentId: string) => void;
  onDecide: ChatContext['onDecide'];
  onAdd: (request: AddAgentRequest) => void;
  onLimit: (max: number | null) => void;
  onClose: (agentId: string) => void;
  jump: Jump | null;
};

const LIMITS = [1, 2, 3, 4, 5, 6, 8, 10];

/** Working now: not finished, and not a worker waiting for your next message. */
export const isRunning = (a: Agent) => !a.endedAt && a.status !== 'idle';

function pill(a: Agent, waiting: boolean): [PillStatus, string?] {
  if (a.status === 'stopped') return ['done', 'Stopped by you'];
  if (a.status === 'failed') return ['error'];
  if (a.status === 'done') return ['done'];
  if (a.status === 'stopping') return ['stopping'];
  if (a.status === 'idle') return ['done', 'Idle'];
  return waiting ? ['waiting'] : ['running'];
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Everything this subagent did, newest at the bottom; shown while its card is selected. */
function Feed({ agent, events, ctx, jump }: { agent: Agent; events: ForgeEvent[]; ctx: ChatContext; jump: Jump | null }) {
  const items = useMemo(() => buildChat(events, agent.agentId), [events, agent.agentId]);
  const ref = useRef<HTMLDivElement>(null);
  useJump(ref, agent.agentId, jump);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items.length]);
  return (
    <div className="cockpit-sub__feed" ref={ref} aria-label={`Activity of ${agent.description ?? 'subagent'}`}>
      {items.length ? <ChatItems items={items} ctx={ctx} /> : <p className="fa-empty">Nothing logged yet.</p>}
    </div>
  );
}

type CardProps = {
  agent: Agent;
  waiting: boolean;
  color: string;
  parentName?: string;
  selected: boolean;
  dimmed: boolean;
  feedCtx: ChatContext;
  events: ForgeEvent[];
  onSelect: () => void;
  onSteer: (text: string) => void;
  onStop: () => void;
  onClose: () => void;
  jump: Jump | null;
};

function SubagentCard({ agent, waiting, color, parentName, selected, dimmed, feedCtx, events, onSelect, onSteer, onStop, onClose, jump }: CardProps) {
  const [text, setText] = useState('');
  const card = useRef<HTMLDivElement>(null);
  // Selected from elsewhere (a spawn row in the chat): bring the card into view.
  useEffect(() => {
    if (selected) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  const [status, label] = pill(agent, waiting);
  const name = agent.description ?? agent.agentType ?? 'Subagent';
  const queued = agent.notes.filter((n) => n.status === 'queued');
  const finished = !!agent.endedAt;
  const worker = agent.kind === 'worker';
  const stats = [
    agent.model && modelLabel(agent.model),
    agent.manual && !worker && 'added by you',
    agent.toolUses != null && `${agent.toolUses} tool call${agent.toolUses === 1 ? '' : 's'}`,
    agent.tokens != null && `${tokens(agent.tokens)} tokens`,
  ].filter(Boolean).join(' · ');

  return (
    <div ref={card} className={`fa-sub${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`} style={{ ['--agent' as string]: color }}>
      <button className="fa-sub__head" aria-pressed={selected} onClick={onSelect} title={selected ? 'Hide activity' : 'Show activity'}>
        <span className="fa-sub__cap" />
        <span className="fa-sub__name">{name}</span>
        <StatusPill status={status} label={label} />
      </button>
      {finished ? (
        <p className="fa-sub__summary fa-meta">
          {label ?? (agent.status === 'failed' ? 'Ended' : 'Done')} in {duration(Date.parse(agent.endedAt!) - Date.parse(agent.startedAt))}
          {stats && ` · ${stats}`}
          {!selected && agent.summary && ` · ${plainText(agent.summary).split('\n').find((l) => l.trim()) ?? ''}`}
        </p>
      ) : (
        <div className="fa-sub__body">
          {agent.status === 'idle' ? (
            <p className="fa-meta cockpit-sub__meta">Waiting for your next message.</p>
          ) : (
            <div className="fa-tool fa-tool--on-surface" title={agent.currentAction}>
              <span className="fa-tool__name">{agent.current?.tool ?? agent.lastTool ?? (worker ? 'Worker' : agent.agentType ?? 'Agent')}</span>
              <span className="fa-tool__target">{agent.current?.target || agent.currentAction || (worker ? 'Thinking…' : 'Starting…')}</span>
            </div>
          )}
          {(parentName || stats) && <p className="fa-meta cockpit-sub__meta">{[worker && 'Worker', parentName && `From ${parentName}`, stats].filter(Boolean).join(' · ')}</p>}
          {queued.map((n) => (
            <div key={n.id} className="fa-sub__note">
              <StatusPill status="queued" />
              <span className="fa-sub__note-text">{n.text}</span>
            </div>
          ))}
          <form className="fa-sub__steer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSteer(text.trim()); setText(''); } }}>
            <input
              className="fa-input"
              placeholder={worker ? (agent.status === 'idle' ? 'Message this agent…' : 'Steer this agent…') : 'Steer this subagent…'}
              aria-label={`${worker ? 'Message' : 'Steer'} ${name}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button className="fa-btn fa-btn--secondary fa-btn--sm" disabled={!text.trim()}>{worker && agent.status === 'idle' ? 'Send' : 'Steer'}</button>
            {agent.status !== 'idle' && (
              <button type="button" className="fa-btn fa-btn--danger fa-btn--sm" onClick={onStop} disabled={agent.stopRequested}>
                {agent.stopRequested ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </form>
          {worker && (
            <button type="button" className="fa-link fa-link--danger cockpit-sub__close" onClick={() => confirm(`Close ${name}? Its Claude process ends; its activity stays here.`) && onClose()}>
              Close agent
            </button>
          )}
        </div>
      )}
      {selected && <Feed agent={agent} events={events} ctx={{ ...feedCtx, speaker: { name, color } }} jump={jump} />}
    </div>
  );
}

/** Every subagent the session has spawned: running ones first, each with steer and stop. Select one to see its activity. */
export function SubagentPanel({ session, agents, events, pending, selected, colorOf, nameOf, onSelect, onSteer, onStop, onDecide, onAdd, onLimit, onClose, jump }: Props) {
  const [adding, setAdding] = useState(false);
  const waiting = new Set(pending.map((p) => p.agentId));
  // Running ones on top; finished ones keep spawn order below.
  const ordered = [...agents].sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt));
  const running = agents.filter(isRunning).length;
  const finished = agents.filter((a) => a.endedAt).length;
  const idle = agents.filter((a) => !a.endedAt && a.status === 'idle').length;
  const limit = session?.maxRunning ?? null;
  const atLimit = limit !== null && running >= limit ? limit : null;
  const feedCtx: ChatContext = { nameOf, colorOf, oldestPending: pending[0]?.id, onDecide, onSelectAgent: onSelect, speaker: { name: '', color: '' }, onSurface: true };

  return (
    <section className="fa-card cockpit-subagents" aria-label="Subagents">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title">Subagents</h2>
        <span className="fa-card__bar" />
        <button className="fa-btn" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Cancel' : 'Add agent'}</button>
      </div>
      <div className="fa-card__body cockpit-subagents__list">
        <div className="cockpit-sub__toolbar">
          <span className="fa-meta cockpit-sub__counts">
            {agents.length ? [`${running} running`, idle && `${idle} idle`, `${finished} finished`].filter(Boolean).join(' · ') : 'No subagents yet.'}
          </span>
          <label className="fa-meta cockpit-sub__limit" title="Most agents allowed to work at once. Claude is told to wait when it's reached.">
            Limit
            <select className="fa-input" value={limit ?? ''} onChange={(e) => onLimit(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None</option>
              {LIMITS.map((n) => <option key={n} value={n}>{n} at once</option>)}
            </select>
          </label>
        </div>
        {adding && (
          <AddAgentForm
            agentTypes={session?.agentTypes ?? []}
            atLimit={atLimit}
            onCancel={() => setAdding(false)}
            onStart={(request) => {
              onAdd(request);
              setAdding(false);
            }}
          />
        )}
        {ordered.map((a) => (
          <SubagentCard
            key={a.agentId}
            agent={a}
            waiting={waiting.has(a.agentId)}
            color={colorOf(a.agentId) ?? 'var(--steel)'}
            parentName={a.parentId ? nameOf(a.parentId) : undefined}
            selected={selected === a.agentId}
            dimmed={!!selected && selected !== a.agentId}
            feedCtx={feedCtx}
            events={events}
            onSelect={() => onSelect(selected === a.agentId ? null : a.agentId)}
            onSteer={(text) => onSteer(a.agentId, text)}
            onStop={() => onStop(a.agentId)}
            onClose={() => onClose(a.agentId)}
            jump={jump}
          />
        ))}
      </div>
    </section>
  );
}
