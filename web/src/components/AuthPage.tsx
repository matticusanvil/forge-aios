import { useState } from 'react';

type Props = { passwordSet: boolean; onSignedIn: () => void };

async function post(path: string, body: object): Promise<string | null> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return null;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'That didn’t work.';
}

/** AuthShell: the shared-password sign-in, or, before there is a password, setting it with the server's setup code. */
export function AuthPage({ passwordSet, onSignedIn }: Props) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setError(null);
    if (!passwordSet && password !== confirm) return setError('The two passwords don’t match.');
    setPending(true);
    const err = passwordSet ? await post('/api/login', { password }) : await post('/api/password', { next: password, proof: code });
    setPending(false);
    if (err) setError(err);
    else onSignedIn();
  };

  return (
    <main className="fa-auth">
      <div className="fa-auth__col">
        <p className="fa-auth__eyebrow">Forge AIOS</p>
        <h1 className="fa-auth__title">{passwordSet ? 'Sign in' : 'Set a password'}</h1>
        <div className="fa-auth__bar" aria-hidden="true"><span /><span /></div>
        <div className="fa-auth__panel">
          <form className="fa-stack-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {error && (
              <p className="fa-msg fa-msg--error" role="alert"><span className="fa-msg__cap">Error</span><span className="fa-msg__body">{error}</span></p>
            )}
            {!passwordSet && (
              <label className="fa-field">
                <span className="fa-field__label">Setup code</span>
                <input className="fa-input fa-input--data" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" />
                <span className="fa-field__hint">It’s in the server’s container log: docker logs forge-aios.</span>
              </label>
            )}
            <label className="fa-field">
              <span className="fa-field__label">{passwordSet ? 'Password' : 'New password'}</span>
              <input className="fa-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={passwordSet} autoComplete={passwordSet ? 'current-password' : 'new-password'} />
              <span className="fa-field__hint">{passwordSet ? 'The shared password set on the server.' : 'At least 10 characters. Anyone with it can run code on the server.'}</span>
            </label>
            {!passwordSet && (
              <label className="fa-field">
                <span className="fa-field__label">Same password again</span>
                <input className="fa-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </label>
            )}
            <div className="cockpit-auth__actions">
              <button className="fa-btn" disabled={pending || !password || (!passwordSet && !code.trim())}>
                {pending ? (passwordSet ? 'Signing in…' : 'Saving…') : passwordSet ? 'Sign in' : 'Set password'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
