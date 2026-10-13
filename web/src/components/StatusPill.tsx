export type PillStatus = 'running' | 'waiting' | 'queued' | 'stopping' | 'done' | 'error';

const WORDS: Record<PillStatus, string> = { running: 'Running', waiting: 'Waiting', queued: 'Queued', stopping: 'Stopping', done: 'Done', error: 'Error' };

/** One status word on its status fill. `bar` squares it to sit in the top bar. */
export function StatusPill({ status, label, bar }: { status: PillStatus; label?: string; bar?: boolean }) {
  return <span className={`fa-pill fa-pill--${status}${bar ? ' fa-pill--bar' : ''}`}>{label ?? WORDS[status]}</span>;
}
