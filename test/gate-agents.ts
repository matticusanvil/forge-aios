// Gate for the agent limit and Add agent: the cap refuses spawns past the limit; workers run on the chosen model and
// hold a conversation; "reports to main" agents launch with the user's exact spec.
// Usage: FORGE_URL=http://host:3200 node test/gate-agents.ts   Starts a new session; mutes phone pushes while it runs.

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

const c = await Client.open(`${BASE.replace(/^http/, 'ws')}/ws`);
const resultFor = (agentId: string | null, from: number) => (e: Ev) => e.source === 'stream' && e.kind.startsWith('result') && e.agentId === agentId && c.events.indexOf(e) >= from;
const repliesOf = (agentId: string | null, from: number) =>
  c.events.slice(from).filter((e) => e.source === 'stream' && e.kind === 'assistant' && e.agentId === agentId)
    .flatMap((e) => e.payload.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)).join('\n');
const modelsOf = (agentId: string, from: number) =>
  [...new Set(c.events.slice(from).filter((e) => e.source === 'stream' && e.kind === 'assistant' && e.agentId === agentId).map((e) => e.payload.message.model))];
const counting = (letter: string, n: number) =>
  `Run these shell commands one at a time, each as its own separate Bash call: ${Array.from({ length: n }, (_, i) => `\`echo ${letter}${i + 1} && sleep 2\``).join(', ')}. Then reply with the last line you printed.`;

try {
  c.send({ type: 'config', phoneMuted: true, maxRunning: null });
  c.send({ type: 'reset', approvals: 'ask' });
  await sleep(1500);
  c.onEvent((e) => {
    if (e.kind === 'approval.requested') c.send({ type: 'decide', id: e.payload.id, decision: /^Bash: echo/.test(e.payload.summary) ? 'allow-session' : 'allow' });
  });

  // 1. With a limit of 1, two parallel spawns: one starts, one is refused.
  c.send({ type: 'config', maxRunning: 1 });
  let from = c.events.length;
  c.send({
    type: 'send',
    text: `Launch two general-purpose subagents in parallel, in a single message. First: description "Cap A", task word for word: "${counting('A', 3)}" ` +
      `Second: description "Cap B", task word for word: "${counting('B', 3)}" If one is refused, don't retry it; just tell me.`,
  });
  await c.waitFor('first turn', from, resultFor(null, from), 300_000);
  await c.waitForAgents('spawned subagents finished', (list) => list.filter((a) => a.kind === 'subagent').every((a) => a.endedAt), 180_000);
  const refused = c.events.slice(from).filter((e) => e.kind === 'spawn.refused');
  const started = c.agents.filter((a) => a.kind === 'subagent');
  check('limit 1: one spawn starts, the parallel one is refused', started.length === 1 && refused.length >= 1, { started: started.map((a) => a.description), refused: refused.length });
  const refusedRow = buildChat(c.events).find((i) => i.kind === 'spawn' && i.refused);
  check('the refused spawn is marked in the chat', !!refusedRow);
  c.send({ type: 'config', maxRunning: null });

  // 2. A worker on Haiku: answers, holds a second turn, then closes.
  from = c.events.length;
  c.send({ type: 'addAgent', request: { mode: 'worker', name: 'Haiku helper', model: 'haiku', task: 'Reply with exactly: WORKER READY' } });
  const w = (await c.waitForAgents('worker', (list) => list.some((a) => a.kind === 'worker'))).find((a) => a.kind === 'worker');
  await c.waitForAgents('worker idle', (list) => list.find((a) => a.agentId === w.agentId)?.status === 'idle', 180_000);
  check('worker answers its task', /WORKER READY/.test(repliesOf(w.agentId, from)), repliesOf(w.agentId, from).slice(0, 80));
  check('worker runs on the chosen model', modelsOf(w.agentId, from).every((m) => /haiku/.test(m)) && modelsOf(w.agentId, from).length > 0, modelsOf(w.agentId, from));
  const turn2 = c.events.length;
  c.send({ type: 'steer', agentId: w.agentId, text: 'Now reply with exactly: SECOND TURN' });
  await c.waitFor('worker second turn', turn2, resultFor(w.agentId, turn2), 180_000);
  check('worker holds a conversation (second turn)', /SECOND TURN/.test(repliesOf(w.agentId, turn2)), repliesOf(w.agentId, turn2).slice(0, 80));
  const feed = buildChat(c.events, w.agentId);
  check("worker's feed shows its task, your message and its replies", ['task', 'you', 'claude'].every((k) => feed.some((i) => i.kind === k)), [...new Set(feed.map((i) => i.kind))]);
  c.send({ type: 'closeAgent', agentId: w.agentId });
  await c.waitForAgents('worker closed', (list) => !!list.find((a) => a.agentId === w.agentId)?.endedAt, 30_000);
  check('closing a worker ends it', true);

  // 3. "Reports to main": main launches it with the user's exact name, model and task, and gets its report.
  from = c.events.length;
  c.send({ type: 'addAgent', request: { mode: 'main', name: 'Probe', model: 'haiku', agentType: 'general-purpose', task: 'Reply with exactly: PROBE OK' } });
  const probe = (await c.waitForAgents('probe subagent', (list) => list.some((a) => a.description === 'Probe'), 180_000)).find((a) => a.description === 'Probe');
  await c.waitForAgents('probe finished', (list) => !!list.find((a) => a.agentId === probe.agentId)?.endedAt, 180_000);
  await c.waitFor('main turn after probe', from, resultFor(null, from), 240_000);
  const final = c.agents.find((a) => a.agentId === probe.agentId);
  check('main launched it with your name, model and type', final.manual && final.model === 'haiku' && final.agentType === 'general-purpose', { manual: final.manual, model: final.model, type: final.agentType });
  check('it ran on the chosen model', modelsOf(probe.agentId, from).every((m) => /haiku/.test(m)) && modelsOf(probe.agentId, from).length > 0, modelsOf(probe.agentId, from));
  check('it ran your exact task and main got the report', /PROBE OK/.test(final.summary ?? '') || /PROBE OK/.test(repliesOf(null, from)), { summary: final.summary, main: repliesOf(null, from).slice(0, 120) });

  // 4. At the limit, Add agent is refused too.
  c.send({ type: 'config', maxRunning: 1 });
  from = c.events.length;
  c.send({ type: 'addAgent', request: { mode: 'worker', name: 'Long counter', model: 'haiku', task: counting('L', 6) } });
  const long = (await c.waitForAgents('long worker', (list) => list.some((a) => a.description === 'Long counter'))).find((a) => a.description === 'Long counter');
  c.send({ type: 'addAgent', request: { mode: 'worker', name: 'One too many', model: 'haiku', task: 'Reply with OK' } });
  const blocked = await c.waitFor('agent.refused', from, (e) => e.kind === 'agent.refused', 15_000).catch(() => null);
  check('at the limit, Add agent is refused', !!blocked && !c.agents.some((a) => a.description === 'One too many'), blocked?.payload);
  c.send({ type: 'closeAgent', agentId: long.agentId });
  c.send({ type: 'config', maxRunning: null });
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  c.send({ type: 'config', phoneMuted: false, maxRunning: null });
  await sleep(300);
  c.close();
}

const failed = checks.filter((x) => !x.pass);
console.log(`\nGate agents: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
