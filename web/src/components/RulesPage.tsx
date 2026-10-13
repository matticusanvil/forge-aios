import { useState, type ReactNode } from 'react';
import { APPROVAL_LEVELS, MODELS, modelLabel, type Agent, type ApprovalLevel, type Rule, type Rules, type SessionState, type WikiInfo } from '../../../shared/types.ts';
import type { ClientMessage } from '../useForge.ts';
import { StatusPill } from './StatusPill.tsx';

type Props = {
  session: SessionState;
  agents: Agent[];
  allowRules: Rule[];
  send: (msg: ClientMessage) => void;
};

const LIMITS = [1, 2, 3, 4, 5, 6, 8, 10];
const PUSH_AFTER = [1, 2, 5, 10, 15, 30, 60];

const limitWord = (n: number | null | undefined) => (n == null ? 'No limit' : `${n} at once`);
const onOff = (v: boolean) => (v ? 'On' : 'Off');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fa-card">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title">{title}</h2>
        <span className="fa-card__bar" />
      </div>
      <div className="fa-card__body fa-stack-4">{children}</div>
    </section>
  );
}

/** One rule: its control for this session, and how it stands against the default. */
function RuleRow({ label, hint, control, isDefault, defaultText, onMakeDefault, onReset }: {
  label: string; hint?: string; control: ReactNode; isDefault: boolean; defaultText: string; onMakeDefault: () => void; onReset: () => void;
}) {
  return (
    <div className="cockpit-rule">
      <div className="cockpit-rule__label">
        <span className="fa-field__label">{label}</span>
        {hint && <span className="fa-field__hint">{hint}</span>}
      </div>
      <div className="cockpit-rule__control">{control}</div>
      <p className="fa-meta cockpit-rule__default">
        {isDefault ? (
          'Default'
        ) : (
          <>
            Default: {defaultText} · <button className="fa-link" onClick={onMakeDefault}>Make this the default</button> ·{' '}
            <button className="fa-link" onClick={onReset}>Reset</button>
          </>
        )}
      </p>
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="cockpit-add__modes" role="radiogroup" aria-label={label}>
      {[true, false].map((v) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={`fa-btn fa-btn--sm${value === v ? '' : ' fa-btn--secondary'}`} onClick={() => onChange(v)}>
          {onOff(v)}
        </button>
      ))}
    </div>
  );
}

function WikiRow({ wiki, linked, byDefault, onLink, onDefault, onRemove }: {
  wiki: WikiInfo; linked: boolean; byDefault: boolean; onLink: (on: boolean) => void; onDefault: (on: boolean) => void; onRemove: () => void;
}) {
  return (
    <div className="cockpit-wiki">
      <div className="cockpit-wiki__main">
        <span className="fa-table__name">{wiki.name}</span>
        <span className="fa-table__sub">
          {wiki.pages ?? 0} pages · {wiki.remote ? <a href={wiki.remote} target="_blank" rel="noreferrer">{wiki.remote.replace('https://github.com/', '')}</a> : 'on the server only'}
        </span>
        {wiki.detail && <span className="fa-table__sub">{wiki.detail}</span>}
      </div>
      {wiki.status === 'ready' ? (
        <div className="cockpit-wiki__actions">
          <button className={`fa-btn fa-btn--sm${linked ? '' : ' fa-btn--secondary'}`} onClick={() => onLink(!linked)} aria-pressed={linked}>
            {linked ? 'Linked' : 'Link'}
          </button>
          <button className="fa-link" onClick={() => onDefault(!byDefault)}>{byDefault ? 'Linked by default' : 'Link by default'}</button>
          <button
            className="fa-link fa-link--danger"
            onClick={() => confirm(`Remove ${wiki.name} from the server? Every project stops linking it.${wiki.remote ? ' Its GitHub repo stays.' : ' It has no GitHub copy, so it’s gone for good.'}`) && onRemove()}
          >
            Remove
          </button>
        </div>
      ) : (
        <StatusPill status={wiki.status === 'error' ? 'error' : 'running'} label={wiki.status === 'error' ? 'Error' : 'Working'} />
      )}
    </div>
  );
}

/** Session rules: every setting a session runs under, each with its default; change it for this session or make it the default. */
export function RulesPage({ session, agents, allowRules, send }: Props) {
  const { rules, defaults } = session;
  const [repo, setRepo] = useState('');
  const [wikiName, setWikiName] = useState('');
  const [subject, setSubject] = useState('');
  const set = (patch: Partial<Rules>) => send({ type: 'setRules', rules: patch });
  const setDefault = (patch: Partial<Rules>) => send({ type: 'setDefaults', rules: patch });
  const row = <K extends keyof Rules>(key: K, text: (v: Rules[K]) => string) => ({
    isDefault: same(rules[key], defaults[key]),
    defaultText: text(defaults[key]),
    onMakeDefault: () => setDefault({ [key]: rules[key] } as Partial<Rules>),
    onReset: () => set({ [key]: defaults[key] } as Partial<Rules>),
  });
  // "Allow everything" lets Claude run anything without asking, so it's never one accidental click away.
  const chooseLevel = (level: ApprovalLevel) => {
    if (level === 'all' && !window.confirm('Allow everything: Claude will run any command and change any file without asking you, including deleting files and pushing code. Only choose this for a project you could lose. Continue?')) return;
    set({ approvals: level });
  };
  const running = (model: string) =>
    agents.filter((a) => !a.endedAt && a.status !== 'idle' && (a.model === model || (!a.model && (session.mainModel ?? 'opus') === model))).length;

  return (
    <div className="cockpit-rules">
      <div className="fa-page-header">
        <div>
          <h1 className="fa-page-header__title">Session rules</h1>
          <p className="fa-page-header__subtitle">
            {session.sessionName ?? 'Unnamed session'} · {session.projectName}. Each new session starts from the defaults; change a rule for this session, or make it the default.
          </p>
        </div>
      </div>

      <div className="cockpit-rules__grid">
        <Card title="Models">
          <RuleRow
            label="Main session"
            hint="Changing it restarts Claude on the same conversation, after the current turn."
            control={
              <select className="fa-input" value={rules.mainModel ?? ''} onChange={(e) => set({ mainModel: e.target.value || null })}>
                <option value="">CLI default</option>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            }
            {...row('mainModel', (v) => modelLabel(v ?? undefined) ?? 'CLI default')}
          />
          <RuleRow
            label="New workers"
            hint="The model Add agent starts a worker on."
            control={
              <select className="fa-input" value={rules.workerModel} onChange={(e) => set({ workerModel: e.target.value })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            }
            {...row('workerModel', (v) => modelLabel(v) ?? v)}
          />
        </Card>

        <Card title="Agent limits">
          <RuleRow
            label="Running at once"
            hint="All agents together. Past the limit, Claude is told to wait or do the work itself."
            control={
              <select className="fa-input" value={rules.maxRunning ?? ''} onChange={(e) => set({ maxRunning: e.target.value ? Number(e.target.value) : null })}>
                <option value="">No limit</option>
                {LIMITS.map((n) => <option key={n} value={n}>{n} at once</option>)}
              </select>
            }
            {...row('maxRunning', limitWord)}
          />
          <div className="cockpit-rule">
            <div className="cockpit-rule__label">
              <span className="fa-field__label">By model</span>
              <span className="fa-field__hint">A subagent that doesn't name a model counts as the main session's.</span>
            </div>
            <div className="fa-table-wrap">
            <table className="fa-table cockpit-rules__table">
              <thead>
                <tr><th>Model</th><th>Limit</th><th>Now</th><th>Default</th></tr>
              </thead>
              <tbody>
                {MODELS.map((m) => {
                  const value = rules.maxByModel[m.id] ?? null;
                  const def = defaults.maxByModel[m.id] ?? null;
                  return (
                    <tr key={m.id}>
                      <td>{m.label}</td>
                      <td>
                        <select className="fa-input" aria-label={`${m.label} limit`} value={value ?? ''} onChange={(e) => set({ maxByModel: { ...rules.maxByModel, [m.id]: e.target.value ? Number(e.target.value) : null } })}>
                          <option value="">No limit</option>
                          {LIMITS.map((n) => <option key={n} value={n}>{n} at once</option>)}
                        </select>
                      </td>
                      <td className="fa-data">{running(m.id)}</td>
                      <td className="fa-meta">
                        {value === def ? limitWord(def) : (
                          <button className="fa-link" onClick={() => setDefault({ maxByModel: { ...defaults.maxByModel, [m.id]: value } })}>Make default</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </Card>

        <Card title="Approvals">
          <RuleRow
            label="Approval level"
            hint={APPROVAL_LEVELS.find((l) => l.id === rules.approvals)?.hint ?? ''}
            control={
              <select className="fa-input" aria-label="Approval level" value={rules.approvals} onChange={(e) => chooseLevel(e.target.value as ApprovalLevel)}>
                {APPROVAL_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            }
            {...row('approvals', (v) => APPROVAL_LEVELS.find((l) => l.id === v)?.label ?? v)}
          />
          <RuleRow
            label="Auto-allow read-only tools"
            hint="Read, Glob, Grep and the like run without asking. Off: every one asks, at any approval level."
            control={<Toggle label="Auto-allow read-only tools" value={rules.autoAllowReadOnly} onChange={(v) => set({ autoAllowReadOnly: v })} />}
            {...row('autoAllowReadOnly', onOff)}
          />
          <div className="cockpit-rule">
            <div className="cockpit-rule__label">
              <span className="fa-field__label">Allowed for this session</span>
              <span className="fa-field__hint">What “Allow for session” has remembered. Cleared by a new session.</span>
            </div>
            {allowRules.length ? (
              allowRules.map((r) => (
                <div key={r.key} className="fa-diff">
                  <span className="fa-diff__file fa-mono">{r.label}</span>
                  <button className="fa-link fa-link--danger" onClick={() => send({ type: 'removeRule', key: r.key })}>Remove</button>
                </div>
              ))
            ) : (
              <p className="fa-empty">None yet.</p>
            )}
          </div>
        </Card>

        <Card title="Phone">
          <RuleRow
            label="Phone pushes"
            hint={session.phone || rules.phone ? 'Approvals with Allow and Deny buttons, through ntfy.' : 'Approvals wait for the browser.'}
            control={<Toggle label="Phone pushes" value={rules.phone} onChange={(v) => set({ phone: v })} />}
            {...row('phone', onOff)}
          />
          <RuleRow
            label="“Finished” push"
            hint="When a turn runs longer than this, your phone is told it finished."
            control={
              <select className="fa-input" value={rules.finishedPushAfterMin} onChange={(e) => set({ finishedPushAfterMin: Number(e.target.value) })}>
                {PUSH_AFTER.map((n) => <option key={n} value={n}>After {n} min</option>)}
              </select>
            }
            {...row('finishedPushAfterMin', (v) => `After ${v} min`)}
          />
        </Card>

        <Card title="Context wikis">
          <p className="fa-field__hint cockpit-rules__intro">
            Linked wikis are read only. Claude reads a wiki's index first and follows its CLAUDE.md. Linking or unlinking restarts Claude on the same conversation.
          </p>
          {session.wikis.length ? (
            session.wikis.map((w) => (
              <WikiRow
                key={w.id}
                wiki={w}
                linked={rules.wikis.includes(w.id)}
                byDefault={defaults.wikis.includes(w.id)}
                onLink={(on) => set({ wikis: on ? [...rules.wikis, w.id] : rules.wikis.filter((x) => x !== w.id) })}
                onDefault={(on) => setDefault({ wikis: on ? [...defaults.wikis, w.id] : defaults.wikis.filter((x) => x !== w.id) })}
                onRemove={() => send({ type: 'wikiRemove', id: w.id })}
              />
            ))
          ) : (
            <p className="fa-empty">No wikis yet.</p>
          )}

          <form className="cockpit-rules__form" onSubmit={(e) => { e.preventDefault(); if (repo.trim()) { send({ type: 'wikiAdd', repo: repo.trim() }); setRepo(''); } }}>
            <label className="fa-field cockpit-grow">
              <span className="fa-field__label">Add from GitHub</span>
              <input className="fa-input fa-input--data" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/wiki-repo" />
            </label>
            <button className="fa-btn fa-btn--secondary" disabled={!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())}>Add and link</button>
          </form>

          <form className="fa-stack-4 cockpit-rules__create" onSubmit={(e) => { e.preventDefault(); if (wikiName.trim()) { send({ type: 'wikiCreate', name: wikiName.trim(), subject }); setWikiName(''); setSubject(''); } }}>
            <span className="fa-field__label">Create from this session</span>
            <p className="fa-field__hint">
              A new wiki in the knowledge-graph layout (CLAUDE.md rules plus wiki/ pages). This session becomes its first source; a worker on {modelLabel(rules.workerModel)} ingests it, then Forge pushes it to a new private GitHub repo and links it.
            </p>
            <label className="fa-field">
              <span className="fa-field__label">Name</span>
              <input className="fa-input" value={wikiName} onChange={(e) => setWikiName(e.target.value)} placeholder="Forge AIOS" maxLength={60} />
            </label>
            <label className="fa-field">
              <span className="fa-field__label">Subject</span>
              <textarea className="fa-input cockpit-add__task" value={subject} onChange={(e) => setSubject(e.target.value)} rows={3} placeholder="What the wiki is about, in a sentence or two." />
            </label>
            <div><button className="fa-btn" disabled={!wikiName.trim()}>Create wiki</button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}
