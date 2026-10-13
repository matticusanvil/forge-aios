import { redact, toolSummary } from '../shared/text.ts';
import type { Agent, ForgeEvent } from '../shared/types.ts';

const AGENT_TOOLS = new Set(['Agent', 'Task']);

const day = (iso: string) => iso.slice(0, 10);
const time = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const at = (iso: string) => time.format(new Date(iso));

/**
 * A readable record of a session for a wiki to ingest: what you asked, what Claude said, each tool call on one
 * line, and what each subagent reported. Secrets are masked; tool output is left out (it's in the code, not the story).
 */
export function sessionTranscript(events: ForgeEvent[], agents: Agent[], meta: { name: string; project: string; model: string | null }): string {
  const lines: string[] = [];
  const started = events[0]?.ts ?? new Date().toISOString();
  lines.push(`# Session record: ${meta.name}`, '');
  lines.push(`- Project: ${meta.project}`, `- Date: ${day(started)}`, `- Main model: ${meta.model ?? 'CLI default'}`, `- Recorded by Forge AIOS`, '');
  lines.push('## Conversation', '');

  let tools: string[] = [];
  const flushTools = () => {
    if (tools.length) lines.push(...tools.map((t) => `- ${t}`), '');
    tools = [];
  };

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.source === 'forge' && e.kind === 'user.message' && !e.agentId) {
      flushTools();
      lines.push(`**You (${at(e.ts)}):** ${redact(String(p.text))}`, '');
    } else if (e.source === 'stream' && e.kind === 'assistant' && !e.agentId) {
      for (const b of p.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) {
          flushTools();
          lines.push(`**Claude (${at(e.ts)}):** ${redact(b.text.trim())}`, '');
        } else if (b.type === 'tool_use') {
          tools.push(AGENT_TOOLS.has(b.name) ? `Launched subagent "${b.input?.description ?? 'subagent'}"` : redact(toolSummary(b.name, b.input)));
        }
      }
    }
  }
  flushTools();

  const done = agents.filter((a) => a.summary);
  if (done.length) {
    lines.push('## Subagent reports', '');
    for (const a of done) lines.push(`### ${a.description ?? a.agentType ?? 'Subagent'}`, '', redact(a.summary!.trim()), '');
  }
  return `${lines.join('\n').trim()}\n`;
}
