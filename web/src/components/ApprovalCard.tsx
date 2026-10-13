import { useState } from 'react';
import { toolTarget } from '../../../shared/text.ts';
import type { Approval } from '../../../shared/types.ts';

type Decision = { decision: string; by: string; note: string | null };

type Props = {
  approval: Approval;
  agentName: string;
  decision?: Decision;
  /** Only the oldest pending approval shows its buttons; the rest wait in line (design system: don't stack cards). */
  queued?: boolean;
  onDecide: (decision: 'allow' | 'deny' | 'allow-session', note?: string) => void;
};

const BY: Record<string, string> = { phone: ' · from your phone', timeout: ' · no answer in time', interrupt: ' · cancelled', reset: ' · cancelled' };

/** A permission request, inline in the chat. Collapses to ALLOWED or DENIED once answered. */
export function ApprovalCard({ approval, agentName, decision, queued, onDecide }: Props) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const target = toolTarget(approval.input);

  if (decision) {
    const allowed = decision.decision !== 'deny';
    return (
      <p className={`fa-msg ${allowed ? 'fa-msg--success' : 'fa-msg--error'}`} role="status">
        <span className="fa-msg__cap">{allowed ? 'Allowed' : 'Denied'}</span>
        <span className="fa-msg__body">
          <span className="fa-mono cockpit-ellipsis">
            {approval.tool} · {target || '—'}
            {decision.decision === 'allow-session' ? ` · ${approval.ruleLabel} allowed for this session` : ''}
            {BY[decision.by] ?? ''}
            {decision.note ? ` · ${decision.note}` : ''}
          </span>
        </span>
      </p>
    );
  }

  if (queued) {
    return (
      <p className="fa-msg fa-msg--warning" role="status">
        <span className="fa-msg__cap">Waiting</span>
        <span className="fa-msg__body">
          <span className="fa-mono cockpit-ellipsis">{agentName} · {approval.tool} · {target || '—'}</span>
        </span>
      </p>
    );
  }

  return (
    <div className="fa-approval" role="group" aria-label={`Approval for ${agentName}`}>
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h3 className="fa-card__title">Approval · {agentName}</h3>
        <span className="fa-card__bar" />
      </div>
      <div className="fa-approval__body">
        <div className="fa-tool fa-tool--on-surface">
          <span className="fa-tool__name">{approval.tool}</span>
          <span className="fa-tool__target cockpit-wrap">{target || '—'}</span>
        </div>
        {approval.why && <p className="fa-approval__why">{approval.why}</p>}
        {denying ? (
          <form className="fa-approval__actions" onSubmit={(e) => { e.preventDefault(); onDecide('deny', note.trim() || undefined); }}>
            <input className="fa-input cockpit-grow" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell Claude why, or what to do instead (optional)" aria-label="Deny note" />
            <button className="fa-btn fa-btn--danger">Deny</button>
            <button type="button" className="fa-link" onClick={() => setDenying(false)}>Cancel</button>
          </form>
        ) : (
          <div className="fa-approval__actions">
            <button className="fa-btn" onClick={() => onDecide('allow')}>Allow</button>
            <button className="fa-btn fa-btn--secondary" onClick={() => onDecide('allow-session')} title={`Remembers: ${approval.ruleLabel}`}>Allow for session</button>
            <button className="fa-link" onClick={() => setDenying(true)}>Deny with note</button>
          </div>
        )}
        <p className="fa-meta">Allow for session remembers {approval.ruleLabel} until you start a new session.</p>
      </div>
    </div>
  );
}
