import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../../shared/types.ts';
import { projectHref } from '../route.ts';
import type { ClientMessage, ForgeState } from '../useForge.ts';
import { AccountCard } from './AccountCard.tsx';
import { StatusPill, type PillStatus } from './StatusPill.tsx';

type Props = {
  projects: ProjectSummary[];
  current: string | null;
  result: ForgeState['projectResult'];
  send: (msg: ClientMessage) => void;
  onSignedOut: () => void;
};

function status(p: ProjectSummary): [PillStatus, string] {
  if (p.waiting) return ['waiting', `${p.waiting} waiting`];
  if (p.busy) return ['running', 'Working'];
  if (p.running) return ['running', `${p.running} agent${p.running === 1 ? '' : 's'}`];
  if (p.live) return ['done', 'Idle'];
  return ['done', p.sessionName ? 'Parked' : 'No session'];
}

/** Every project on the server, with what each is doing, and adding one: clone from GitHub, or start empty. */
export function ProjectsPage({ projects, current, result, send, onSignedOut }: Props) {
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A clone or create finished: open the new project, or say what went wrong.
  useEffect(() => {
    if (!result || !pending) return;
    setPending(null);
    if (result.ok && result.name) location.hash = projectHref(result.name);
    else setError(result.error ?? 'That didn’t work.');
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  const working = projects.filter((p) => p.busy || p.running).length;
  const waiting = projects.reduce((n, p) => n + p.waiting, 0);

  return (
    <div className="cockpit-rules">
      <div className="fa-page-header">
        <div>
          <h1 className="fa-page-header__title">Projects</h1>
          <p className="fa-page-header__subtitle">Every repo in /srv/repos. Each keeps its own session running while you look at another.</p>
        </div>
      </div>

      <div className="fa-tiles cockpit-projects__tiles">
        <div className="fa-tile"><span className="fa-tile__value">{projects.length}</span><span className="fa-tile__label">Projects</span></div>
        <div className="fa-tile"><span className="fa-tile__value">{working}</span><span className="fa-tile__label">Working now</span></div>
        <div className={`fa-tile${waiting ? ' fa-tile--gold' : ''}`}><span className="fa-tile__value">{waiting}</span><span className="fa-tile__label">Waiting for you</span></div>
      </div>

      <div className="cockpit-rules__grid">
        <section className="fa-card">
          <div className="fa-card__head"><span className="fa-card__cap" /><h2 className="fa-card__title">All projects</h2><span className="fa-card__bar" /></div>
          <div className="fa-card__body fa-table-wrap">
            <table className="fa-table">
              <thead><tr><th>Project</th><th>Session</th><th>Status</th></tr></thead>
              <tbody>
                {projects.map((p) => {
                  const [s, label] = status(p);
                  return (
                    <tr key={p.name}>
                      <td>
                        <a className="fa-table__name" href={projectHref(p.name)}>{p.name}</a>
                        {p.name === current && <span className="fa-table__sub">Open</span>}
                      </td>
                      <td>{p.sessionName ?? '—'}</td>
                      <td><StatusPill status={s} label={label} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fa-card">
          <div className="fa-card__head"><span className="fa-card__cap" /><h2 className="fa-card__title">Add a project</h2><span className="fa-card__bar" /></div>
          <div className="fa-card__body fa-stack-4">
            <form className="cockpit-rules__form" onSubmit={(e) => { e.preventDefault(); setError(null); setPending('clone'); send({ type: 'projectClone', repo: repo.trim() }); }}>
              <label className="fa-field cockpit-grow">
                <span className="fa-field__label">Clone from GitHub</span>
                <input className="fa-input fa-input--data" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
              </label>
              <button className="fa-btn" disabled={!!pending || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim())}>{pending === 'clone' ? 'Cloning…' : 'Clone'}</button>
            </form>
            <form className="cockpit-rules__form cockpit-rules__create" onSubmit={(e) => { e.preventDefault(); setError(null); setPending('create'); send({ type: 'projectCreate', name: name.trim() }); }}>
              <label className="fa-field cockpit-grow">
                <span className="fa-field__label">New empty project</span>
                <input className="fa-input fa-input--data" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-new-thing" maxLength={64} />
              </label>
              <button className="fa-btn fa-btn--secondary" disabled={!!pending || !/^[A-Za-z0-9][\w.-]*$/.test(name.trim())}>{pending === 'create' ? 'Creating…' : 'Create'}</button>
            </form>
            {error && (
              <p className="fa-msg fa-msg--error" role="alert"><span className="fa-msg__cap">Error</span><span className="fa-msg__body">{error}</span></p>
            )}
            <p className="fa-field__hint">Cloning uses the server’s GitHub login. A new project starts as a git repo with a README.</p>
          </div>
        </section>

        <AccountCard onSignedOut={onSignedOut} />
      </div>
    </div>
  );
}
