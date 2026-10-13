import { useState } from 'react';

/** Sign out, and change the shared password (which signs out every other browser). */
export function AccountCard({ onSignedOut }: { onSignedOut: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const change = async () => {
    const res = await fetch('/api/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next, proof: current }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setMessage(res.ok ? { ok: true, text: 'Password changed. Other browsers are signed out.' } : { ok: false, text: body.error ?? 'That didn’t work.' });
    if (res.ok) {
      setCurrent('');
      setNext('');
    }
  };

  return (
    <section className="fa-card">
      <div className="fa-card__head">
        <span className="fa-card__cap" />
        <h2 className="fa-card__title">Access</h2>
        <span className="fa-card__bar" />
        <button className="fa-btn fa-btn--secondary" onClick={async () => { await fetch('/api/logout', { method: 'POST' }); onSignedOut(); }}>Sign out</button>
      </div>
      <form className="fa-card__body fa-stack-4" onSubmit={(e) => { e.preventDefault(); change(); }}>
        {message && (
          <p className={`fa-msg ${message.ok ? 'fa-msg--success' : 'fa-msg--error'}`} role={message.ok ? 'status' : 'alert'}>
            <span className="fa-msg__cap">{message.ok ? 'Saved' : 'Error'}</span>
            <span className="fa-msg__body">{message.text}</span>
          </p>
        )}
        <div className="fa-grid-2">
          <label className="fa-field">
            <span className="fa-field__label">Current password</span>
            <input className="fa-input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="fa-field">
            <span className="fa-field__label">New password</span>
            <input className="fa-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            <span className="fa-field__hint">At least 10 characters.</span>
          </label>
        </div>
        <div><button className="fa-btn fa-btn--secondary" disabled={!current || next.length < 10}>Change password</button></div>
      </form>
    </section>
  );
}
