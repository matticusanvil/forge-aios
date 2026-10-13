import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

// The shared password guards everything that can run code. Sign-ins last 30 days.
const SESSION_DAYS = 30;
const COOKIE = 'forge_session';
const MIN_PASSWORD = 10;
// After this many wrong passwords from one address, it waits a minute (and longer each time).
const MAX_FAILURES = 5;

type Stored = { salt?: string; hash?: string; sessions: { id: string; created: string }[] };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hashPassword = (password: string, salt: string) => scryptSync(password, salt, 64).toString('hex');
const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookies(req: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

/**
 * The shared password and its sign-ins, kept hashed in /data/auth.json. Until a password is set, the first sign-in
 * screen needs a one-time setup code from the container log, so only someone with server access can set it.
 * Scripts and tests use FORGE_API_TOKEN as a bearer token instead.
 */
export class Auth {
  readonly setupCode: string | null;
  private file: string;
  private data: Stored;
  private apiToken: string | null;
  private failures = new Map<string, { count: number; until: number }>();

  constructor(dataDir: string, apiToken: string | undefined) {
    this.file = path.join(dataDir, 'auth.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { sessions: [] };
    }
    this.apiToken = apiToken && apiToken.length >= 24 ? apiToken : null;
    this.setupCode = this.passwordSet ? null : randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-');
  }

  get passwordSet(): boolean {
    return !!this.data.hash;
  }

  /** Signed in by cookie, or a script with the API token. */
  allowed(req: http.IncomingMessage): boolean {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && this.apiToken && equal(bearer, this.apiToken)) return true;
    const token = cookies(req)[COOKIE];
    return !!token && this.data.sessions.some((s) => equal(s.id, sha256(token)) && Date.now() - Date.parse(s.created) < SESSION_DAYS * 864e5);
  }

  /** null if the address must wait after too many wrong passwords; otherwise whether the password is right. */
  check(ip: string, password: string): boolean | null {
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) return null;
    const ok = !!this.data.hash && equal(hashPassword(password, this.data.salt!), this.data.hash);
    if (ok) this.failures.delete(ip);
    else {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + 60_000 * 2 ** (count - MAX_FAILURES) : 0 });
    }
    return ok;
  }

  /** Sets the password: the first time with the setup code, later with the current password. Signs everyone else out. */
  setPassword(next: string, proof: string, ip: string): string | null {
    if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
    if (this.passwordSet) {
      const ok = this.check(ip, proof);
      if (ok === null) return 'Too many wrong passwords. Wait a minute and try again.';
      if (!ok) return 'The current password is wrong.';
    } else if (!this.setupCode || !equal(proof.trim().toUpperCase(), this.setupCode)) {
      return 'That setup code is wrong. It’s in the container log: docker logs forge-aios.';
    }
    const salt = randomBytes(16).toString('hex');
    this.data = { salt, hash: hashPassword(next, salt), sessions: [] };
    this.save();
    return null;
  }

  /** A new sign-in: the token goes in the cookie; only its hash is kept. */
  signIn(res: http.ServerResponse): void {
    const token = randomBytes(32).toString('base64url');
    const cutoff = Date.now() - SESSION_DAYS * 864e5;
    this.data.sessions = [...this.data.sessions.filter((s) => Date.parse(s.created) > cutoff), { id: sha256(token), created: new Date().toISOString() }];
    this.save();
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  }

  signOut(req: http.IncomingMessage, res: http.ServerResponse): void {
    const token = cookies(req)[COOKIE];
    if (token) {
      this.data.sessions = this.data.sessions.filter((s) => !equal(s.id, sha256(token)));
      this.save();
    }
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
