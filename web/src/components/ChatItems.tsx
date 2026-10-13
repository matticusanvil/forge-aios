import { useMemo, type ReactNode } from 'react';
import { modelLabel } from '../../../shared/types.ts';
import { clock, duration, type ChatItem } from '../chat.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { Markdown } from './Markdown.tsx';
import { ToolRow } from './ToolRow.tsx';

export type Speaker = { name: string; color: string };

export type ChatContext = {
  nameOf: (agentId: string | null) => string;
  colorOf: (agentId: string | undefined) => string | undefined;
  /** Only the oldest pending approval shows its buttons. */
  oldestPending?: string;
  onDecide: (id: string, decision: 'allow' | 'deny' | 'allow-session', note?: string) => void;
  onSelectAgent: (agentId: string) => void;
  /** Who "claude" items are from: the main session, or a subagent in its feed. */
  speaker: Speaker;
  /** Inside a surface-2 card, tool rows sit on black. */
  onSurface?: boolean;
  /** The main chat: a subagent's approval shows here while it waits or if denied; once allowed, only its feed keeps it. */
  main?: boolean;
};

export const MAIN_SPEAKER: Speaker = { name: 'Claude', color: 'var(--agent-gold)' };
const YOU: Speaker = { name: 'You', color: 'var(--steel)' };

/** One turn: a speaker pill and a time over the body. Yours sit on the right. */
export function Turn({ speaker, you, time, children }: { speaker: Speaker; you?: boolean; time: string; children: ReactNode }) {
  return (
    <div className={`fa-chat${you ? ' fa-chat--you' : ''}`}>
      <div className="fa-chat__head">
        {you && <span className="fa-meta">{time}</span>}
        <span className="fa-pill fa-pill--agent cockpit-ellipsis" style={{ ['--agent' as string]: speaker.color }}>{speaker.name}</span>
        {!you && <span className="fa-meta">{time}</span>}
      </div>
      <div className="fa-chat__body">{children}</div>
    </div>
  );
}

function Item({ item, ctx }: { item: ChatItem; ctx: ChatContext }) {
  switch (item.kind) {
    case 'you':
      return (
        <Turn speaker={YOU} you time={clock(item.at)}>
          <p className="cockpit-pre">{item.text}</p>
          {item.queuedNoteId && !item.delivered && <span className="fa-pill fa-pill--queued">Queued for its next step</span>}
        </Turn>
      );
    case 'claude':
      return (
        <Turn speaker={ctx.speaker} time={clock(item.at)}>
          <Markdown text={item.text} />
        </Turn>
      );
    case 'task':
      return (
        <Turn speaker={{ name: 'Task', color: 'var(--sand)' }} time={clock(item.at)}>
          <p className="cockpit-pre cockpit-task">{item.text}</p>
        </Turn>
      );
    case 'tool': {
      const a = item.approval;
      // Waiting: the card stands in for the row (it shows the call itself). Denied: the row, then why. Allowed: the row is enough.
      const waiting = a && !a.decision;
      const showCard = a && (waiting || a.decision?.decision === 'deny');
      return (
        <div className="fa-stack-1">
          {!waiting && <ToolRow item={item} onSurface={ctx.onSurface} />}
          {showCard && (
            <ApprovalCard
              approval={a.approval}
              agentName={ctx.nameOf(a.approval.agentId)}
              decision={a.decision}
              queued={!a.decision && a.approval.id !== ctx.oldestPending}
              onDecide={(d, note) => ctx.onDecide(a.approval.id, d, note)}
            />
          )}
        </div>
      );
    }
    case 'spawn':
      return (
        <button className={`fa-tool cockpit-tool__row${ctx.onSurface ? ' fa-tool--on-surface' : ''}`} onClick={() => item.agentId && ctx.onSelectAgent(item.agentId)} disabled={!item.agentId}>
          <span className="fa-tool__agent" style={{ ['--agent' as string]: ctx.colorOf(item.agentId) ?? 'var(--steel)' }} />
          <span className="fa-tool__target">
            {item.subagentType === 'worker' ? 'Started' : 'Spawned'} <u>{item.description}</u> · {item.subagentType}
            {item.model && ` · ${modelLabel(item.model)}`}
          </span>
          {item.byYou && <span className="fa-pill fa-pill--done">Added by you</span>}
          {item.refused && <span className="fa-pill fa-pill--waiting" title="Refused: the running-agents limit was reached">Over limit</span>}
          <span className="fa-meta">{clock(item.at)}</span>
        </button>
      );
    case 'approval':
      return (
        <ApprovalCard
          approval={item.approval}
          agentName={ctx.nameOf(item.approval.agentId)}
          decision={item.decision}
          queued={!item.decision && item.approval.id !== ctx.oldestPending}
          onDecide={(d, note) => ctx.onDecide(item.approval.id, d, note)}
        />
      );
    case 'turn':
      return item.isError ? (
        <p className="fa-msg fa-msg--error"><span className="fa-msg__cap">Error</span><span className="fa-msg__body">{item.text}</span></p>
      ) : (
        <p className="fa-meta cockpit-turn">Finished in {duration(item.durationMs)} · {clock(item.at)}</p>
      );
    case 'notice':
      return (
        <p className={`fa-msg fa-msg--${item.tone}`}><span className="fa-msg__cap">{item.cap}</span><span className="fa-msg__body">{item.text}</span></p>
      );
  }
}

/** Each item carries its id in the DOM, so the timeline and file history can jump to it. */
function Wrapped({ item, ctx }: { item: ChatItem; ctx: ChatContext }) {
  if (hidden(item, ctx)) return null;
  return <div className="cockpit-item" data-chat-id={item.id}><Item item={item} ctx={ctx} /></div>;
}

/** In the main chat, a subagent's approval shows while it waits or if denied; once allowed, only its feed keeps it. */
const hidden = (item: ChatItem, ctx: ChatContext) =>
  item.kind === 'approval' && !!ctx.main && !!item.approval.agentId && !!item.decision && item.decision.decision !== 'deny';

/** A conversation's items in order. Consecutive tool and spawn rows stack with the 4px LCARS seam. */
export function ChatItems({ items, ctx }: { items: ChatItem[]; ctx: ChatContext }) {
  const blocks = useMemo(() => {
    const out: (ChatItem | ChatItem[])[] = [];
    for (const item of items) {
      const isRow = item.kind === 'tool' || item.kind === 'spawn';
      const last = out.at(-1);
      if (isRow && Array.isArray(last)) last.push(item);
      else out.push(isRow ? [item] : item);
    }
    return out;
  }, [items]);

  return (
    <>
      {blocks.map((b) =>
        Array.isArray(b) ? (
          <div key={`rows-${b[0].id}`} className="fa-stack-1">
            {b.map((item) => <Wrapped key={item.id} item={item} ctx={ctx} />)}
          </div>
        ) : (
          <Wrapped key={b.id} item={b} ctx={ctx} />
        ),
      )}
    </>
  );
}
