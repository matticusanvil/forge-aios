// Gate for two additions: the main session's model is chosen on New session, and main hears about notes you send its subagents.
// Usage: FORGE_URL=http://host:3200 node test/gate-extras.ts   Starts new sessions; mutes phone pushes; restores the CLI default model.

import { Client, type Ev } from './client.ts';
import { BASE } from './config.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

const c = await Client.open(`${BASE.replace(/^http/, 'ws')}/ws`);
const mainResult = (from: number) => (e: Ev) => e.source === 'stream' && e.kind.startsWith('result') && !e.agentId && c.events.indexOf(e) >= from;
const mainReply = (from: number) => c.events.slice(from).filter((e) => e.source === 'stream' && e.kind === 'assistant' && !e.agentId)
  .flatMap((e) => e.payload.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)).join('\n');
async function say(text: string): Promise<number> {
  const from = c.events.length;
  c.send({ type: 'send', text });
  await c.waitFor('turn end', from, mainResult(from), 300_000);
  return from;
}

try {
  c.send({ type: 'config', phoneMuted: true });
  c.onEvent((e) => {
    if (e.kind === 'approval.requested') c.send({ type: 'decide', id: e.payload.id, decision: /^Bash: echo/.test(e.payload.summary) ? 'allow-session' : 'allow' });
  });

  // 1. New session on Sonnet: the main session runs on Sonnet.
  c.send({ type: 'reset', approvals: 'ask', model: 'sonnet' });
  await sleep(1500);
  let from = await say('Reply with just OK.');
  const models = [...new Set(c.events.slice(from).filter((e) => e.source === 'stream' && e.kind === 'assistant' && !e.agentId).map((e) => e.payload.message.model))];
  check('a new session runs on the model you picked', models.length > 0 && models.every((m) => /sonnet/.test(m)), models);

  // 2. You steer a subagent while main is idle; main can tell you what you sent it.
  from = c.events.length;
  c.send({
    type: 'send',
    text: 'Launch one general-purpose subagent in the background with the description "Kiwi counter" and this task word for word: ' +
      '"Run these shell commands one at a time, each as its own Bash call: `echo K1 && sleep 3`, `echo K2 && sleep 3`, `echo K3 && sleep 3`, `echo K4 && sleep 3`. Then reply with the last line you printed." Then end your turn.',
  });
  const sub = (await c.waitForAgents('subagent', (list) => list.some((a) => a.description === 'Kiwi counter'), 180_000)).find((a) => a.description === 'Kiwi counter');
  await c.waitFor('subagent ran once', from, (e) => e.source === 'hook' && e.kind === 'PostToolUse' && e.agentId === sub.agentId, 120_000);
  c.send({ type: 'steer', agentId: sub.agentId, text: 'Also print the word KIWI before your next command.' });
  await c.waitForAgents('subagent done', (list) => !!list.find((a) => a.agentId === sub.agentId)?.endedAt, 180_000);
  await c.waitFor('main idle', from, mainResult(from), 180_000);
  await sleep(5000); // main may take a turn when the background subagent reports
  // When the background subagent reports back, the CLI starts a turn for main on its own; the note should ride along on it.
  const relayed = c.events.slice(from).find((e) => e.source === 'hook' && e.kind === 'UserPromptSubmit' && /KIWI/.test(JSON.stringify(e.payload.response ?? {})));
  check("the note reaches main on the turn the CLI starts itself", !!relayed, relayed ? 'via UserPromptSubmit' : 'not relayed before your next message');
  from = await say('Did I send your subagent any steering notes? If so, quote the note exactly; if not, say NONE.');
  check('main knows what you told its subagent', /KIWI/.test(mainReply(from)), mainReply(from).slice(0, 200));
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  c.send({ type: 'reset', approvals: 'ask', model: '' });
  c.send({ type: 'config', phoneMuted: false });
  await sleep(500);
  c.close();
}
const failed = checks.filter((x) => !x.pass);
console.log(`\nGate extras: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
