import type { ReactNode } from 'react';
import { modelLabel, type ProjectSummary, type SessionState } from '../../../shared/types.ts';
import { projectHref } from '../route.ts';
import { StatusPill, type PillStatus } from './StatusPill.tsx';

type Props = {
  session: SessionState | null;
  connected: boolean;
  pendingApprovals: number;
  /** Subagents still working; they can run on after the main turn ends. */
  runningAgents: number;
  onInterrupt: () => void;
  /** Which page is open. */
  view: 'cockpit' | 'rules' | 'projects';
  projects: ProjectSummary[];
  children: ReactNode;
};

function sessionPill(session: SessionState | null, connected: boolean, pending: number, running: number): [PillStatus, string] {
  if (!connected) return ['error', 'Disconnected'];
  if (session?.login && !session.login.loggedIn) return ['error', 'Not logged in'];
  if (pending > 0) return ['waiting', 'Waiting for you'];
  if (session?.busy) return ['running', 'Session running'];
  if (running > 0) return ['running', `${running} subagent${running === 1 ? '' : 's'} running`];
  return ['done', 'Session idle'];
}

function loginText(session: SessionState | null): string {
  const login = session?.login;
  if (!login) return 'Checking login…';
  if (session.apiKeySource && session.apiKeySource !== 'none') return 'API key billing';
  if (login.method === 'claude.ai') return `Subscription login${login.plan ? ` · ${login.plan}` : ''}`;
  return login.loggedIn ? login.method : 'Not logged in';
}

/** Plan usage from the CLI's rate-limit messages: "5h 12% · 7d 6%". */
function usageText(session: SessionState | null): string | null {
  const w = session?.rateLimits?.unifiedWindows;
  if (!w) return null;
  const parts = [['five_hour', '5h'], ['seven_day', '7d']]
    .filter(([key]) => w[key])
    .map(([key, label]) => `${label} ${Math.round(w[key].utilization * 100)}%`);
  return parts.length ? parts.join(' · ') : null;
}

/** The LCARS frame: one elbow, the top bar with the session's state, the project in the sidebar. */
export function Frame({ session, connected, pendingApprovals, runningAgents, onInterrupt, view, projects, children }: Props) {
  const current = session?.projectName;
  const [status, label] = sessionPill(session, connected, pendingApprovals, runningAgents);
  const usage = usageText(session);
  return (
    <div className="fa-frame cockpit-frame">
      <a className="fa-frame__elbow" href="#/projects" title="All projects">Forge AIOS</a>
      <div className="fa-frame__top">
        <div className="fa-frame__bar">
          <span className="fa-frame__bar-fill" />
          <StatusPill bar status={status} label={label} />
          {pendingApprovals > 0 && <StatusPill bar status="waiting" label={`${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'}`} />}
          {session?.model && <span className="fa-frame__bar-text" title="The main session's model">{modelLabel(session.model)}</span>}
          <span className="fa-frame__bar-text">{loginText(session)}</span>
          {usage && <span className="fa-frame__bar-text" title="Plan usage in the current five-hour and seven-day windows">{usage}</span>}
          <button className="fa-frame__bar-cap cockpit-interrupt" onClick={onInterrupt} disabled={!session?.busy}>
            Interrupt
          </button>
        </div>
      </div>
      <nav className="fa-frame__side" aria-label="Projects">
        {/* ProjectSwitcher: one block per project; gold = open, a square = working, an orange square = waiting for you. */}
        {projects.map((p) => {
          const open = p.name === current && view !== 'projects';
          const working = open ? session!.busy || runningAgents > 0 : p.busy || p.running > 0;
          const waiting = open ? pendingApprovals > 0 : p.waiting > 0;
          return (
            <a key={p.name} className="fa-nav__item" href={projectHref(p.name)} aria-current={open && view === 'cockpit' ? 'page' : undefined} title={p.sessionName ? `${p.name} · ${p.sessionName}` : p.name}>
              {(working || waiting) && <span className={`fa-nav__live${waiting ? ' fa-nav__live--waiting' : ''}`} />}
              {p.name}
            </a>
          );
        })}
        {current && view !== 'projects' && (
          <a className="fa-nav__item cockpit-nav__rules" href={projectHref(current, 'rules')} aria-current={view === 'rules' ? 'page' : undefined}>Rules</a>
        )}
        <span className="fa-frame__spine" />
      </nav>
      <main className="fa-frame__main cockpit-main">{children}</main>
    </div>
  );
}
