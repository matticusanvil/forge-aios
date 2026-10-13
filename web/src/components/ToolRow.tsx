import { useState } from 'react';
import { redact } from '../../../shared/text.ts';
import { duration, type ToolItem } from '../chat.ts';

/** One tool call: name, target and duration. Click to see its input and result. */
export function ToolRow({ item, onSurface }: { item: ToolItem; onSurface?: boolean }) {
  const [open, setOpen] = useState(false);
  const pending = item.result === undefined;
  return (
    <div className={`cockpit-tool${open ? ' is-open' : ''}`}>
      <button className={`fa-tool cockpit-tool__row${onSurface ? ' fa-tool--on-surface' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="fa-tool__name">{item.name}</span>
        <span className="fa-tool__target">{item.target || '—'}</span>
        {item.approval?.decision?.decision === 'allow-session' && <span className="fa-pill fa-pill--done" title="Allowed for this session">Session rule</span>}
        {item.approval?.decision?.by === 'phone' && item.approval.decision.decision !== 'deny' && <span className="fa-pill fa-pill--done" title="Allowed from your phone">Phone</span>}
        {item.isError && !item.approval?.decision?.decision.startsWith('deny') && <span className="fa-pill fa-pill--error">Failed</span>}
        <span className="fa-meta">{pending ? '…' : item.durationMs !== undefined ? duration(item.durationMs) : ''}</span>
      </button>
      {open && (
        <div className="cockpit-tool__detail">
          <div className="fa-card__section-title">Input</div>
          <pre>{redact(JSON.stringify(item.input, null, 2))}</pre>
          {!pending && (
            <>
              <div className="fa-card__section-title">{item.isError ? 'Error' : 'Result'}</div>
              <pre>{item.result ? redact(item.result) : '—'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
