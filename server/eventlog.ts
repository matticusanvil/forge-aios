import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { EventSource, ForgeEvent } from '../shared/types.ts';

export type { EventSource, ForgeEvent } from '../shared/types.ts';

type Row = { id: number; ts: string; source: EventSource; kind: string; session_id: string | null; agent_id: string | null; payload: string };

// Long tool results and file contents would bloat the log; the UI only needs the gist.
const MAX_STRING = 10_000;

function trim(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} chars trimmed]` : value;
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
  return value;
}

const fromRow = (r: Row): ForgeEvent => ({ id: r.id, ts: r.ts, source: r.source, kind: r.kind, sessionId: r.session_id, agentId: r.agent_id, payload: JSON.parse(r.payload) });

/**
 * One project's SQLite file: an append-only log of everything that happens (stream messages, hook calls,
 * Forge's own actions), plus small tables for session state and approval rules.
 */
export class EventLog {
  private db: DatabaseSync;
  private insertStmt: StatementSync;
  private recentStmt: StatementSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_agent ON events (agent_id, id);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS rules (key TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    this.insertStmt = this.db.prepare('INSERT INTO events (ts, source, kind, session_id, agent_id, payload) VALUES (?, ?, ?, ?, ?, ?)');
    this.recentStmt = this.db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id');
  }

  append(e: Omit<ForgeEvent, 'id' | 'ts'>): ForgeEvent {
    const ts = new Date().toISOString();
    const payload = trim(e.payload);
    const { lastInsertRowid } = this.insertStmt.run(ts, e.source, e.kind, e.sessionId, e.agentId, JSON.stringify(payload ?? null));
    return { ...e, payload, id: Number(lastInsertRowid), ts };
  }

  recent(limit: number): ForgeEvent[] {
    return (this.recentStmt.all(limit) as Row[]).map(fromRow);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** "Allow for session" rules. Kept in the database so they survive a restart; cleared by a new session. */
  rules(): { key: string; label: string }[] {
    return this.db.prepare('SELECT key, label FROM rules ORDER BY created_at').all() as { key: string; label: string }[];
  }

  addRule(key: string, label: string): void {
    this.db.prepare('INSERT OR IGNORE INTO rules (key, label, created_at) VALUES (?, ?, ?)').run(key, label, new Date().toISOString());
  }

  clearRules(): void {
    this.db.exec('DELETE FROM rules');
  }

  removeRule(key: string): void {
    this.db.prepare('DELETE FROM rules WHERE key = ?').run(key);
  }
}
