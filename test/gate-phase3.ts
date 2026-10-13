// Phase 3 gate: every subagent appears live on its card, and steer and stop work per card, independently.
// Usage: FORGE_URL=http://host:3200 node test/gate-phase3.ts
// Two subagents count in parallel; one is steered, the other stopped. Starts a new session; mutes phone pushes while it runs.

import { buildChat } from '../web/src/chat.ts';
import { BASE } from './config.ts';
import { Client, type Ev } from './client.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

const counting = (letter: string) =>
  `Run these shell commands one at a time, each as its own separate Bash call, never combined: ` +
  Array.from({ length: 10 }, (_, i) => `\`echo ${letter}${i + 1} && sleep 3\``).join(', ') +
  `. After the last one, reply with the last line you printed.`;

const PROMPT =
  'Launch two general-purpose subagents in parallel, in a single message. ' +
  `Give the first the description "Counter A" and this task word for word: "${counting('A')}" ` +
  `Give the second the description "Counter B" and this task word for word: "${counting('B')}" ` +
  'When both have returned, reply with one line about each.';

const STEER = 'Change of plan: stop counting now and do not run any more commands. Reply with just the word REDIRECTED.';

const c = await Client.open(`${BASE.replace(/^http/, 'ws')}/ws`);
const isTool = (kind: string, agentId: string) => (e: Ev) => e.source === 'hook' && e.kind === kind && e.agentId === agentId;

try {
  c.send({ type: 'config', phoneMuted: true });
  c.send({ type: 'reset', approvals: 'ask' });
  await sleep(1500);
  const from = c.events.length;

  // Answer every approval in this run: the counting commands get a session rule after the first ask.
  c.onEvent((e) => {
    if (e.kind !== 'approval.requested') return;
    const counting = /^Bash: echo [AB]\d+ && sleep 3$/.test(e.payload.summary);
    c.send({ type: 'decide', id: e.payload.id, decision: counting ? 'allow-session' : 'allow' });
  });

  // Track what each card would show as its current action.
  const sawCurrent = new Map<string, string>();
  const watch = setInterval(() => {
    for (const a of c.agents) if (a.current) sawCurrent.set(a.agentId, `${a.current.tool}: ${a.current.target}`);
  }, 100);

  c.send({ type: 'send', text: PROMPT });
  const both = await c.waitForAgents('two running subagents', (list) => list.filter((a) => !a.endedAt).length >= 2);
  check('two subagents appear live at the same time', true, both.map((a) => a.description));
  const a = both.find((x) => /A\b/.test(x.description ?? ''));
  const b = both.find((x) => /B\b/.test(x.description ?? ''));
  if (!a || !b) throw new Error(`could not tell Counter A from Counter B: ${both.map((x) => x.description)}`);

  // Let each get going, then steer A and stop B from their cards.
  await c.waitFor('A has run twice', from, (e) => isTool('PostToolUse', a.agentId)(e) && c.events.slice(from).filter(isTool('PostToolUse', a.agentId)).length >= 2);
  await c.waitFor('B has run twice', from, (e) => isTool('PostToolUse', b.agentId)(e) && c.events.slice(from).filter(isTool('PostToolUse', b.agentId)).length >= 2);
  c.send({ type: 'steer', agentId: a.agentId, text: STEER });
  c.send({ type: 'stop', agentId: b.agentId });

  const delivered = await c.waitFor('note delivered to A', from, (e) => e.kind === 'steer.delivered' && e.agentId === a.agentId);
  const enforced = await c.waitFor('stop enforced on B', from, (e) => e.kind === 'stop.enforced' && e.agentId === b.agentId);
  const ended = await c.waitForAgents('both finished', (list) => [a, b].every((x) => list.find((y) => y.agentId === x.agentId)?.endedAt));
  await c.waitFor('main session result', from, (e) => e.source === 'stream' && e.kind.startsWith('result'), 300_000);
  clearInterval(watch);

  // Background shell commands also report as tasks; only real subagents get cards.
  check('only real subagents get cards', ended.length === 2, ended.map((x) => x.description));
  const finalA = ended.find((x) => x.agentId === a.agentId);
  const finalB = ended.find((x) => x.agentId === b.agentId);
  check('each card showed its current tool call', sawCurrent.has(a.agentId) && sawCurrent.has(b.agentId), Object.fromEntries(sawCurrent));

  // In context mode the call that carries the note still runs; nothing after it should.
  const aRunsAfterNote = c.events.slice(c.events.indexOf(delivered)).filter(isTool('PostToolUse', a.agentId)).length;
  check('steering A redirects it', aRunsAfterNote <= 1 && /REDIRECTED/.test(finalA.summary ?? ''), { aRunsAfterNote, summary: finalA.summary });

  const bRunsAfterStop = c.events.slice(c.events.indexOf(enforced)).filter(isTool('PostToolUse', b.agentId)).length;
  check('stopping B ends it with a report', finalB.status === 'stopped' && bRunsAfterStop === 0 && !!finalB.summary, { status: finalB.status, bRunsAfterStop, summary: (finalB.summary ?? '').slice(0, 120) });

  const bGotNote = c.events.slice(from).some((e) => e.kind === 'steer.delivered' && e.agentId === b.agentId);
  check('steer and stop stay on their own card', !bGotNote && !finalA.stopRequested && finalA.status === 'done', { bGotNote, aStatus: finalA.status });

  // What the cards and the chat render, built from the same events the browser gets.
  const feedA = buildChat(c.events, a.agentId);
  const kinds = new Set(feedA.map((i) => i.kind));
  check("A's activity feed shows its task, tool calls and your note", kinds.has('task') && kinds.has('tool') && feedA.some((i) => i.kind === 'you' && i.delivered), [...kinds]);
  const spawns = buildChat(c.events).filter((i) => i.kind === 'spawn');
  check('spawn rows in the chat link to their subagents', spawns.length >= 2 && spawns.every((s) => s.kind === 'spawn' && s.agentId), spawns.map((s) => s.kind === 'spawn' && s.agentId));
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  c.send({ type: 'config', phoneMuted: false });
  await sleep(300);
  c.close();
}

const failed = checks.filter((x) => !x.pass);
console.log(`\nGate phase 3: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
