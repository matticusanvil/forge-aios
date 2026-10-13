import type { GitState } from '../../../shared/types.ts';
import type { FileRow, JumpTarget } from '../activity.ts';
import { clock } from '../chat.ts';

type Props = {
  rows: FileRow[];
  git: GitState | null;
  selectedAgent: string | null;
  selectedFile: string | null;
  colorOf: (agentId: string | null | undefined) => string;
  nameOf: (agentId: string | null) => string;
  onSelectFile: (path: string | null) => void;
  onJump: (target: JumpTarget) => void;
};

const minus = (n: number | null) => (n === null ? '−?' : `−${n}`);
const plus = (n: number | null) => (n === null ? '+?' : `+${n}`);

/** The activity column: files touched this session, each marked with the agent that last touched it, then the git diff. */
export function ActivityPanel({ rows, git, selectedAgent, selectedFile, colorOf, nameOf, onSelectFile, onJump }: Props) {
  const touched = rows.filter((r) => r.touches.length);
  const dirs = [...new Set(touched.map((r) => r.dir))];
  const selected = rows.find((r) => r.path === selectedFile);
  const changed = git?.files ?? [];

  return (
    <section className="fa-card cockpit-activity" aria-label="Activity">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title">Activity</h2>
        <span className="fa-card__bar" />
      </div>
      <div className="fa-card__body cockpit-activity__scroll">
        {!touched.length && <p className="fa-empty">No files touched yet.</p>}
        {dirs.map((dir) => (
          <div key={dir || '.'}>
            <div className="fa-tree__dir">{dir ? `${dir}/` : 'Project root'}</div>
            {touched.filter((r) => r.dir === dir).map((r) => {
              // Selecting a subagent dims the files it didn't touch (design system: Linking).
              const dimmed = selectedAgent !== null && !r.touches.some((t) => t.agentId === selectedAgent);
              const wrote = r.touches.some((t) => t.kind === 'write');
              return (
                <button
                  key={r.path}
                  className={`fa-tree__file${dimmed ? ' is-dimmed' : ''}${selectedFile === r.path ? ' is-selected' : ''}`}
                  aria-pressed={selectedFile === r.path}
                  title={`${r.path} · last ${wrote ? 'changed' : 'read'} by ${nameOf(r.lastAgent ?? null)} at ${clock(new Date(r.lastAt!).toISOString())}`}
                  onClick={() => {
                    const next = selectedFile === r.path ? null : r.path;
                    onSelectFile(next);
                    const last = r.touches.at(-1);
                    if (next && last) onJump({ scope: last.agentId, id: last.toolUseId });
                  }}
                >
                  <span className="fa-tree__name">{r.name}</span>
                  <span className={`fa-tree__heat fa-tree__heat--${r.heat}`} style={{ ['--agent' as string]: colorOf(r.lastAgent) }} />
                </button>
              );
            })}
          </div>
        ))}
        {touched.length > 0 && <p className="fa-meta cockpit-activity__legend">Brighter square = touched more recently.</p>}

        {selected && (
          <div className="fa-card__section">
            <h3 className="fa-card__section-title">History · {selected.name}</h3>
            {[...selected.touches].reverse().map((t) => (
              <button key={t.toolUseId} className="fa-tree__file cockpit-history" onClick={() => onJump({ scope: t.agentId, id: t.toolUseId })}>
                <span className="fa-tree__heat" style={{ ['--agent' as string]: colorOf(t.agentId) }} />
                <span className="fa-tree__name">{t.tool} · {nameOf(t.agentId)}</span>
                <span className="fa-meta">{clock(new Date(t.at).toISOString())}</span>
              </button>
            ))}
            {!selected.touches.length && <p className="fa-empty">Changed outside this session.</p>}
          </div>
        )}

        <div className="fa-card__section">
          <h3 className="fa-card__section-title">Git diff · {changed.length} file{changed.length === 1 ? '' : 's'}</h3>
          {git?.error && <p className="fa-empty">{git.error}</p>}
          {git?.branch && <p className="fa-meta cockpit-activity__branch">On {git.branch}</p>}
          {!git?.error && !changed.length && <p className="fa-empty">No uncommitted changes.</p>}
          {changed.map((f) => (
            <button
              key={f.file}
              className={`fa-diff cockpit-diff${selectedFile === f.file ? ' is-selected' : ''}`}
              title={`${f.file} · ${f.status}`}
              onClick={() => onSelectFile(selectedFile === f.file ? null : f.file)}
            >
              <span className="fa-diff__file">{f.file}{f.status === 'untracked' ? ' (new)' : f.status === 'deleted' ? ' (deleted)' : ''}</span>
              <span className="fa-diff__add">{plus(f.added)}</span>
              <span className="fa-diff__del">{minus(f.removed)}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
