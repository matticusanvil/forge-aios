// Phase 5 gate: switch between two projects with both sessions intact; projects run side by side.
// Usage: FORGE_URL=http://host:3200 node test/gate-phase5.ts
// Uses playground and playground-b (created if missing), starting a new session in each; mutes phone pushes.

import { Client, type Ev } from './client.ts';
import { BASE } from './config.ts';

const WS = BASE.replace(/^http/, 'ws');
const A = 'playground';
const B = 'playground-b';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

const mainResult = (c: Client, from: number) => (e: Ev) => e.source === 'stream' && e.kind.startsWith('result') && !e.agentId && c.events.indexOf(e) >= from;
const reply = (c: Client, from: number) => c.events.slice(from).filter((e) => e.source === 'stream' && e.kind === 'assistant' && !e.agentId)
  .flatMap((e) => e.payload.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)).join('\n');
async function say(c: Client, text: string): Promise<number> {
  const from = c.events.length;
  c.send({ type: 'send', text });
  await c.waitFor('turn end', from, mainResult(c, from), 300_000);
  return from;
}
const run = Date.now().toString(36).toUpperCase();
const WORD_A = `ALPHA-${run}`;
const WORD_B = `BRAVO-${run}`;

const c = await Client.open(`${WS}/ws?project=${A}`);
const cA = await Client.open(`${WS}/ws?project=${A}`);
try {
  c.send({ type: 'config', phoneMuted: true });
  for (const x of [c, cA]) x.onEvent((e) => e.kind === 'approval.requested' && x.send({ type: 'decide', id: e.payload.id, decision: 'allow' }));
  await sleep(800);

  // 0. The second project exists (made here the first time).
  if (!c.projects.some((p) => p.name === B)) {
    c.send({ type: 'projectCreate', name: B });
    const t = Date.now();
    while (!c.projectResults.length && Date.now() - t < 30_000) await sleep(200);
    check('a new empty project can be created', c.projectResults[0]?.ok === true, c.projectResults[0]);
  }
  c.send({ type: 'projectClone', repo: `example/${A}` });
  const t0 = Date.now();
  const before = c.projectResults.length;
  while (c.projectResults.length === before && Date.now() - t0 < 30_000) await sleep(200);
  check('cloning onto an existing project name is refused', c.projectResults.at(-1)?.ok === false && /already/.test(c.projectResults.at(-1)?.error), c.projectResults.at(-1));

  // 1. A session in each project, each told its own codeword.
  await c.openProject(A);
  c.send({ type: 'reset', approvals: 'ask', name: `Gate p5 ${A}` });
  await sleep(1000);
  await say(c, `Remember this codeword for later: ${WORD_A}. Reply with just OK.`);
  await c.openProject(B);
  check('switching opens the other project', c.session?.projectName === B, c.session?.projectName);
  c.send({ type: 'reset', approvals: 'ask', name: `Gate p5 ${B}` });
  await sleep(1000);
  await say(c, `Remember this codeword for later: ${WORD_B}. Reply with just OK.`);

  // 2. Back and forth: each conversation is still there, and each session still remembers its own codeword.
  await c.openProject(A);
  const historyA = c.events.some((e) => e.kind === 'user.message' && e.payload.text.includes(WORD_A));
  let from = await say(c, 'What codeword did I give you? Reply with just the codeword.');
  check(`${A}: the conversation is still there and remembers its codeword`, historyA && reply(c, from).includes(WORD_A) && !reply(c, from).includes(WORD_B), reply(c, from));
  await c.openProject(B);
  const historyB = c.events.some((e) => e.kind === 'user.message' && e.payload.text.includes(WORD_B));
  from = await say(c, 'What codeword did I give you? Reply with just the codeword.');
  check(`${B}: the conversation is still there and remembers its codeword`, historyB && reply(c, from).includes(WORD_B) && !reply(c, from).includes(WORD_A), reply(c, from));

  // 3. Side by side: A works through a 20-second command while B answers.
  const fromA = cA.events.length;
  cA.send({ type: 'send', text: 'Run this exact shell command in the foreground (not in the background): `for i in $(seq 1 20); do sleep 1; done` and then reply with the word FINISHED.' });
  await cA.waitFor('A running its command', fromA, (e) => e.source === 'hook' && e.kind === 'PreToolUse' && /seq 1 20/.test(JSON.stringify(e.payload.body?.tool_input)) && e.payload.response?.hookSpecificOutput?.permissionDecision === 'allow', 120_000);
  await sleep(1500);
  const busyInList = c.projects.find((p) => p.name === A)?.busy === true;
  from = await say(c, 'Reply with just the word PONG.');
  const aStillBusy = !cA.events.slice(fromA).some(mainResult(cA, fromA));
  check('B answers while A is still working', /PONG/.test(reply(c, from)) && aStillBusy, { b: reply(c, from), aStillBusy });
  check('the sidebar shows A working while B is open', busyInList, c.projects.map((p) => `${p.name}:${p.busy ? 'busy' : 'idle'}`));
  await cA.waitFor('A finished', fromA, mainResult(cA, fromA), 120_000);
  check('A finished its turn on its own', /FINISHED/.test(reply(cA, fromA)), reply(cA, fromA).slice(0, 80));
  check('the sidebar knows each session by name', ['A', 'B'].every((x) => c.projects.find((p) => p.name === (x === 'A' ? A : B))?.sessionName === `Gate p5 ${x === 'A' ? A : B}`),
    c.projects.map((p) => [p.name, p.sessionName]));
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  c.send({ type: 'config', phoneMuted: false });
  await sleep(300);
  c.close();
  cA.close();
}
const failed = checks.filter((x) => !x.pass);
console.log(`\nGate phase 5: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
