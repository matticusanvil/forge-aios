import type { JumpTarget, Lane } from '../activity.ts';
import { clock } from '../chat.ts';

type Props = {
  lanes: Lane[];
  from: number;
  to: number;
  selectedAgent: string | null;
  selectedFile: string | null;
  colorOf: (agentId: string | null | undefined) => string;
  onJump: (target: JumpTarget) => void;
};

const seconds = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

const MARK_WORDS = { note: 'Note', approval: 'Approval', allowed: 'Allowed', stop: 'Stop' } as const;

type Placed = { kind: keyof typeof MARK_WORDS; pos: number; count: number; jump?: JumpTarget };

/** Marks close together would pile up into an unreadable stack: same-kind ones merge ("Allowed ×3"), others step aside. */
function placeMarks(marks: Lane['marks'], pos: (at: number) => number): Placed[] {
  const GAP = 7; // percent of the track one pill needs
  const out: Placed[] = [];
  for (const m of [...marks].sort((a, b) => a.at - b.at)) {
    const last = out.at(-1);
    const p = pos(m.at);
    if (last && last.kind === m.kind && p - last.pos < GAP) {
      last.count++;
      continue;
    }
    out.push({ kind: m.kind, pos: last && p - last.pos < GAP ? last.pos + GAP : p, count: 1, jump: m.jump });
  }
  // Keep every pill inside the track.
  return out.map((m) => ({ ...m, pos: Math.min(96, Math.max(4, m.pos)) }));
}

/** One lane per agent across the session: a tick per tool call, marks for your notes, approvals and stops. Click to jump. */
export function TimelinePanel({ lanes, from, to, selectedAgent, selectedFile, colorOf, onJump }: Props) {
  const span = Math.max(to - from, 60_000);
  // A little room at the right, so the last tick and its mark aren't cut off.
  const pos = (at: number) => Math.min(100, Math.max(0, ((at - from) / (span * 1.04)) * 100));
  const x = (at: number) => `${pos(at)}%`;
  // Short spans need seconds to tell the axis labels apart.
  const label = (at: number) => (span < 5 * 60_000 ? seconds.format(new Date(at)) : clock(new Date(at).toISOString()));
  const axis = [0, 1, 2, 3, 4].map((i) => label(from + (span * 1.04 * i) / 4));

  return (
    <section className="fa-card cockpit-timeline" aria-label="Timeline">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title">Timeline</h2>
        <span className="fa-card__bar" />
      </div>
      <div className="fa-card__body cockpit-timeline__scroll">
        <div className="fa-timeline">
          <div className="fa-timeline__axis">
            <span />
            <div className="fa-timeline__ticks fa-meta">{axis.map((t, i) => <span key={i}>{t}</span>)}</div>
          </div>
          {lanes.map((lane) => (
            <div
              key={lane.agentId ?? 'main'}
              className={`fa-lane${selectedAgent !== null && lane.agentId !== selectedAgent ? ' is-dimmed' : ''}`}
              style={{ ['--agent' as string]: colorOf(lane.agentId) }}
            >
              <span className="fa-lane__label" title={lane.name}>{lane.name}</span>
              <div className="fa-lane__track">
                {lane.ticks.map((t, i) => (
                  <button
                    key={`${t.jump.id}-${i}`}
                    className={`fa-lane__tick${selectedFile && t.path !== selectedFile ? ' cockpit-tick--dim' : ''}`}
                    style={{ left: x(t.at) }}
                    title={`${clock(new Date(t.at).toISOString())} · ${t.tool}${t.target ? `: ${t.target}` : ''}`}
                    aria-label={`${t.tool} at ${clock(new Date(t.at).toISOString())}`}
                    onClick={() => onJump(t.jump)}
                  />
                ))}
                {placeMarks(lane.marks, pos).map((m, i) => {
                  const words = `${MARK_WORDS[m.kind]}${m.count > 1 ? ` ×${m.count}` : ''}`;
                  return m.jump ? (
                    <button key={`m-${i}`} className={`fa-lane__mark fa-lane__mark--${m.kind} cockpit-mark`} style={{ left: `${m.pos}%` }} onClick={() => onJump(m.jump!)}>
                      {words}
                    </button>
                  ) : (
                    <span key={`m-${i}`} className={`fa-lane__mark fa-lane__mark--${m.kind}`} style={{ left: `${m.pos}%` }}>{words}</span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
