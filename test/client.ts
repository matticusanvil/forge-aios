// A WebSocket client for gate tests: keeps every event and waits for the ones a scenario needs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ForgeEvent } from '../shared/types.ts';

/** The server's API token (FORGE_API_TOKEN, or ~/.config/forge-aios/api-token): tests sign in with it, not the password. */
export function apiToken(): string {
  const token = process.env.FORGE_API_TOKEN ?? (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.config/forge-aios/api-token'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  if (!token) throw new Error('No API token: set FORGE_API_TOKEN or write it to ~/.config/forge-aios/api-token.');
  return token;
}

export const authHeaders = () => ({ authorization: `Bearer ${apiToken()}` });

export type Ev = ForgeEvent;

export class Client {
  events: Ev[] = [];
  /** Live text chunks seen (not stored as events). */
  deltas = 0;
  /** Latest session and git state the server sent. */
  session: any = null;
  git: any = null;
  /** Latest project list, and the answers to clone / create. */
  projects: any[] = [];
  projectResults: any[] = [];
  private hellos: any[] = [];
  /** Every agent list the server sent, newest last. */
  agentSnapshots: any[][] = [];
  private eventHandlers = new Set<(e: Ev) => void>();
  private ws: WebSocket;
  private listeners = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (raw) => {
      const msg = JSON.parse(String(raw.data));
      if (msg.type === 'delta') this.deltas++;
      if (msg.type === 'agents') this.agentSnapshots.push(msg.agents);
      if (msg.type === 'hello' || msg.type === 'session') this.session = msg.session;
      if (msg.type === 'hello' || msg.type === 'git') this.git = msg.git;
      if (msg.type === 'hello') this.hellos.push(msg);
      if (msg.type === 'projects') this.projects = msg.projects;
      if (msg.type === 'projectResult') this.projectResults.push(msg);
      if (msg.type === 'event') {
        this.events.push(msg.event);
        for (const fn of this.eventHandlers) fn(msg.event);
        for (const fn of this.listeners) fn();
      }
    };
  }

  static open(url: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: authHeaders() });
      ws.onopen = () => resolve(new Client(ws));
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }

  /** Latest agent list. */
  get agents(): any[] {
    return this.agentSnapshots.at(-1) ?? [];
  }

  onEvent(fn: (e: Ev) => void): () => void {
    this.eventHandlers.add(fn);
    return () => this.eventHandlers.delete(fn);
  }

  /** Resolves when the agent list satisfies `pred`. */
  waitForAgents(label: string, pred: (agents: any[]) => boolean, timeoutMs = 240_000): Promise<any[]> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (pred(this.agents)) return resolve(this.agents);
        if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  /** Switches this connection to another project; its events become that project's history. */
  async openProject(name: string, timeoutMs = 30_000): Promise<void> {
    const before = this.hellos.length;
    this.send({ type: 'open', project: name });
    const started = Date.now();
    while (!this.hellos.slice(before).some((h) => h.session?.projectName === name)) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out opening ${name}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    this.events = [...this.hellos.at(-1).events];
    this.agentSnapshots = [this.hellos.at(-1).agents];
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the first event at index >= from that matches. */
  waitFor(label: string, from: number, pred: (e: Ev) => boolean, timeoutMs = 240_000): Promise<Ev> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.events.slice(from).find(pred);
        if (!hit) return false;
        cleanup();
        resolve(hit);
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    this.ws.close();
  }
}
