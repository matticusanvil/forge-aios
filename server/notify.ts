import { oneLine, redact } from '../shared/text.ts';

// Phone push through an ntfy server (ntfy.sh or your own). Off unless NTFY_URL and NTFY_TOPIC are set.

export type NotifyConfig = { url: string; topic: string; token?: string; publicUrl: string };

export function notifyConfigFromEnv(env: NodeJS.ProcessEnv): NotifyConfig | null {
  if (!env.NTFY_URL || !env.NTFY_TOPIC) return null;
  return {
    url: env.NTFY_URL.replace(/\/+$/, ''),
    topic: env.NTFY_TOPIC,
    token: env.NTFY_TOKEN || undefined,
    publicUrl: (env.FORGE_PUBLIC_URL || 'http://localhost:3200').replace(/\/+$/, ''),
  };
}

export class Notifier {
  /** Set while a gate test runs, so its approvals don't buzz the phone. */
  muted = false;
  /** Phone pushes switched off in the session rules. */
  paused = false;
  private cfg: NotifyConfig | null;
  private onError: (message: string) => void;

  constructor(cfg: NotifyConfig | null, onError: (message: string) => void) {
    this.cfg = cfg;
    this.onError = onError;
  }

  get enabled(): boolean {
    return this.cfg !== null;
  }

  /** Allow and Deny buttons POST the single-use token back. The approval id is the ntfy sequence id, so a decision made in the browser can clear it. */
  approval(id: string, token: string, title: string, summary: string): Promise<void> {
    if (!this.cfg) return Promise.resolve();
    const decide = (d: string) => `${this.cfg!.publicUrl}/api/approvals/${id}/decide?d=${d}&t=${token}`;
    return this.send('POST', '/', {
      sequence_id: id,
      title,
      message: redact(oneLine(summary, 300)),
      priority: 4,
      tags: ['warning'],
      click: this.cfg.publicUrl,
      actions: [
        { action: 'http', label: 'Allow', url: decide('allow'), method: 'POST', clear: true },
        { action: 'http', label: 'Deny', url: decide('deny'), method: 'POST', clear: true },
      ],
    });
  }

  clear(id: string): Promise<void> {
    if (!this.cfg) return Promise.resolve();
    return this.send('PUT', `/${encodeURIComponent(this.cfg.topic)}/${id}/clear`);
  }

  /** A long turn finished, or a session failed, so nobody has to watch the screen. */
  finished(title: string, text: string, failed: boolean): Promise<void> {
    if (!this.cfg) return Promise.resolve();
    return this.send('POST', '/', {
      title,
      message: redact(oneLine(text, 300)),
      priority: 3,
      tags: [failed ? 'x' : 'white_check_mark'],
      click: this.cfg.publicUrl,
    });
  }

  private async send(method: string, path: string, body?: object): Promise<void> {
    const cfg = this.cfg!;
    if (this.muted || this.paused) return;
    try {
      const res = await fetch(`${cfg.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cfg.token && { Authorization: `Bearer ${cfg.token}` }) },
        body: body && JSON.stringify({ topic: cfg.topic, ...body }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.onError(`ntfy ${method} ${path}: ${res.status} ${oneLine(await res.text())}`);
    } catch (err) {
      this.onError(`ntfy ${method} ${path}: ${(err as Error).message}`);
    }
  }
}
