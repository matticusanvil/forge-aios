import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MODELS, type Agent, type Approval, type SessionState } from '../../../shared/types.ts';
import { clock, type ChatItem } from '../chat.ts';
import { useJump, type Jump } from '../jump.ts';
import { ChatItems, MAIN_SPEAKER, Turn, type ChatContext } from './ChatItems.tsx';
import { Markdown } from './Markdown.tsx';

type Props = {
  items: ChatItem[];
  live: string;
  session: SessionState | null;
  connected: boolean;
  agents: Agent[];
  pending: Approval[];
  colorOf: (agentId: string | undefined) => string | undefined;
  onSend: (text: string) => void;
  onDecide: (id: string, decision: 'allow' | 'deny' | 'allow-session', note?: string) => void;
  /** model: an alias, or '' for the CLI's default. */
  onNewSession: (model: string, name: string) => void;
  onName: (name: string) => void;
  onSelectAgent: (agentId: string) => void;
  /** A jump from the timeline or file history; acted on when it targets the main session. */
  jump: Jump | null;
};

/** Problems the user must act on, in the README's words: what happened, then what to do. */
function Warnings({ session, connected }: { session: SessionState | null; connected: boolean }) {
  const warnings: [string, string][] = [];
  if (!connected) warnings.push(['Error', 'Lost the connection to the server. Reconnecting…']);
  if (session?.apiKeySource && session.apiKeySource !== 'none') {
    warnings.push(['Warning', 'The CLI is using an API key, not your subscription. Unset ANTHROPIC_API_KEY in the container and restart.']);
  }
  if (session?.login && !session.login.loggedIn) {
    warnings.push(['Error', 'The CLI isn’t logged in. Run claude auth login inside the forge-aios container.']);
  }
  return (
    <>
      {warnings.map(([cap, text]) => (
        <p key={text} className={`fa-msg ${cap === 'Error' ? 'fa-msg--error' : 'fa-msg--warning'}`} role="alert">
          <span className="fa-msg__cap">{cap}</span>
          <span className="fa-msg__body">{text}</span>
        </p>
      ))}
    </>
  );
}

/** New session: what it costs you (Claude's memory of this conversation, session rules), and which model runs next. */
function NewSessionPanel({ current, onStart, onCancel }: { current: string | null; onStart: (model: string, name: string) => void; onCancel: () => void }) {
  const [model, setModel] = useState(current ?? '');
  const [name, setName] = useState('');
  return (
    <form className="cockpit-newsession" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onStart(model, name.trim()); }}>
      <p className="cockpit-newsession__text">Start a new session? Claude forgets this conversation, workers are closed, and the rules go back to your defaults.</p>
      <label className="fa-field">
        <span className="fa-field__label">Session name</span>
        <input className="fa-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What's this session for?" maxLength={80} />
      </label>
      <div className="fa-approval__actions">
        <label className="fa-field cockpit-newsession__model">
          <span className="fa-field__label">Model</span>
          <select className="fa-input" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">CLI default</option>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <button className="fa-btn" disabled={!name.trim()}>Start new session</button>
        <button type="button" className="fa-link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** A session without a name asks for one; a fresh one won't take messages until it has it. */
function NamePanel({ onName }: { onName: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form className="cockpit-newsession" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onName(name.trim()); }}>
      <p className="cockpit-newsession__text">Name this session first. It shows here and in Claude Code’s session list.</p>
      <div className="fa-approval__actions">
        <input className="fa-input cockpit-grow" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What's this session for?" maxLength={80} aria-label="Session name" />
        <button className="fa-btn" disabled={!name.trim()}>Save name</button>
      </div>
    </form>
  );
}

function Composer({ busy, disabled, onSend }: { busy: boolean; disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText('');
  };
  return (
    <form className="cockpit-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={ref}
        className="fa-input cockpit-composer__input"
        rows={1}
        value={text}
        placeholder={busy ? 'Steer Claude while it works…' : 'Message Claude…'}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className="fa-btn" disabled={disabled || !text.trim()}>Send</button>
      <p className="fa-meta cockpit-composer__hint">
        {busy ? 'Claude is working. What you send now reaches it at its next step.' : 'Enter sends, Shift+Enter adds a line.'}
      </p>
    </form>
  );
}

/** The main session: the conversation in the gold card, with tool rows, spawns and approvals in the order they happened. */
export function ChatPanel({ items, live, session, connected, agents, pending, colorOf, onSend, onDecide, onNewSession, onSelectAgent, jump, onName }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [confirmingNew, setConfirmingNew] = useState(false);
  useJump(scroller, null, jump);
  const pinned = useRef(true);
  const oldestPending = pending[0]?.id;
  const nameOf = (agentId: string | null) => (agentId ? (agents.find((a) => a.agentId === agentId)?.description ?? 'Subagent') : 'Claude');

  // Stick to the bottom while new content arrives, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, live]);

  const ctx: ChatContext = { nameOf, colorOf, oldestPending, onDecide, onSelectAgent, speaker: MAIN_SPEAKER, main: true };

  return (
    <section className="fa-card cockpit-chat" aria-label="Main session">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title cockpit-ellipsis" title={session?.sessionName ?? undefined}>{session?.sessionName ? `Main session · ${session.sessionName}` : 'Main session'}</h2>
        <span className="fa-card__bar" />
        <button className="fa-btn fa-btn--secondary" onClick={() => setConfirmingNew(!confirmingNew)} disabled={!connected} aria-expanded={confirmingNew}>New session</button>
      </div>
      <div
        className="cockpit-chat__scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {confirmingNew && (
          <NewSessionPanel
            current={session?.mainModel ?? null}
            onCancel={() => setConfirmingNew(false)}
            onStart={(model, name) => {
              setConfirmingNew(false);
              onNewSession(model, name);
            }}
          />
        )}
        {session && !session.sessionName && !confirmingNew && <NamePanel onName={onName} />}
        <Warnings session={session} connected={connected} />
        {!items.length && !live && <p className="fa-empty">No messages yet. Ask Claude something about {session?.projectName ?? 'this project'}.</p>}
        <ChatItems items={items} ctx={ctx} />
        {live && (
          <Turn speaker={MAIN_SPEAKER} time={clock(new Date().toISOString())}>
            <Markdown text={live} />
          </Turn>
        )}
      </div>
      <Composer busy={!!session?.busy} disabled={!connected || (!!session && !session.sessionName && !items.length)} onSend={onSend} />
    </section>
  );
}
