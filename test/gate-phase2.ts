// Phase 2 gate: a whole session runs from the browser's channel, with approvals, deny notes, interrupt and mid-turn messages.
// Usage: FORGE_URL=http://host:3200 node test/gate-phase2.ts
// Runs against a live Forge AIOS server whose project is a scratch repo (it writes hello.txt there). Starts a new session.

import { Client, type Ev } from './client.ts';
import { BASE } from './config.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A fresh file name each run, so leftovers from an earlier run don't change what Claude does.
const FILE = `hello-${Date.now().toString(36)}.txt`;
const KEPT = FILE.replace('.txt', '-kept.txt');

type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

const c = await Client.open(`${BASE.replace(/^http/, 'ws')}/ws`);
const isKind = (kind: string) => (e: Ev) => e.kind === kind;
const approvalFor = (pattern: RegExp) => (e: Ev) => e.kind === 'approval.requested' && pattern.test(`${e.payload.tool} ${JSON.stringify(e.payload.input)}`);
const turnEnd = (from: number) => c.waitFor('turn end', from, (e) => e.source === 'stream' && e.kind.startsWith('result'), 300_000);
const lastReply = (from: number) =>
  c.events.slice(from).filter((e) => e.source === 'stream' && !e.agentId && e.kind === 'assistant')
    .flatMap((e) => e.payload.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)).join('\n');

async function say(text: string): Promise<number> {
  const from = c.events.length;
  c.send({ type: 'send', text });
  await c.waitFor('user.message', from, isKind('user.message'));
  return from;
}

type Answer = { decision: 'allow' | 'deny' | 'allow-session'; note?: string };

/** Sends a message and answers each approval in that turn with `decide`, until the turn ends. */
async function runTurn(text: string, decide: (approval: any) => Answer): Promise<{ from: number; approvals: any[] }> {
  const from = await say(text);
  const seen = new Set<string>();
  const approvals: any[] = [];
  for (;;) {
    const e = await c.waitFor('approval or turn end', from, (x) => (x.kind === 'approval.requested' && !seen.has(x.payload.id)) || (x.source === 'stream' && x.kind.startsWith('result')), 300_000);
    if (e.kind !== 'approval.requested') return { from, approvals };
    seen.add(e.payload.id);
    approvals.push(e.payload);
    c.send({ type: 'decide', id: e.payload.id, ...decide(e.payload) });
  }
}

try {
  // 0. The page and the locked-down endpoints.
  const page = await fetch(`${BASE}/`).then((r) => r.text());
  check('web app is served', page.includes('<div id="root"'));
  const hook = await fetch(`${BASE}/hooks/playground/PreToolUse`, { method: 'POST', body: '{}' });
  check('hook endpoint refuses callers from the network', hook.status === 403, hook.status);
  const phone = await fetch(`${BASE}/api/approvals/nope/decide?d=allow&t=x`, { method: 'POST' });
  check('phone endpoint refuses an unknown approval', phone.status === 410, phone.status);

  c.send({ type: 'config', phoneMuted: true });
  c.send({ type: 'reset', approvals: 'ask' });
  await sleep(1500);

  // 1. A write needs approval; allowing it lets the file land. Then "Allow for session" on a command.
  let turn = await runTurn(
    `Create a file named ${FILE} containing exactly the line: Hello from Forge AIOS. Then run the shell command \`cat ${FILE}\` and reply with what it printed.`,
    (a) => (a.summary.startsWith('Bash: cat ') && a.summary.includes(FILE) ? { decision: 'allow-session' } : { decision: 'allow' }),
  );
  let from = turn.from;
  check('a file write asks for approval', turn.approvals.some((a) => a.summary.includes(FILE) && !a.summary.startsWith('Bash: cat')), turn.approvals.map((a) => a.summary));
  check('the reply shows the file was written and read', /Hello from Forge AIOS/.test(lastReply(from)), lastReply(from).slice(0, 120));
  check('the reply streamed in live', c.deltas > 0, c.deltas);

  // 2. The session rule now covers the same command without asking. (Extra commands, like a pipe into wc, still ask.)
  turn = await runTurn(`Run exactly the shell command \`cat ${FILE}\` once more, with nothing piped or added, then reply with its line count.`, () => ({ decision: 'allow' }));
  from = turn.from;
  const asked = turn.approvals.some((a) => /^Bash: cat \S+$/.test(a.summary) && a.summary.includes(FILE));
  const auto = c.events.slice(from).some((e) => e.kind === 'approval.auto');
  check('"Allow for session" covers the repeat without asking', !asked && auto, turn.approvals.map((a) => a.summary));

  // 3. A deny with a note redirects Claude.
  turn = await runTurn(`Delete ${FILE} with the rm command.`, (a) =>
    /\brm\b/.test(a.summary) ? { decision: 'deny', note: `Keep it. Rename it to ${KEPT} with mv instead.` } : { decision: 'allow' });
  const rmAt = turn.approvals.findIndex((a) => /\brm\b/.test(a.summary));
  const mvAfter = turn.approvals.slice(rmAt + 1).some((a) => /\bmv\b/.test(a.summary));
  check('a deny note redirects Claude (it asks to mv instead)', rmAt !== -1 && mvAfter, turn.approvals.map((a) => a.summary));

  // 4. Interrupt stops a long command; the session keeps working afterwards.
  from = await say('Run this exact shell command in the foreground (not in the background): `for i in $(seq 1 45); do echo $i; sleep 1; done` and then reply with the word done.');
  const sl = await c.waitFor('loop approval', from, approvalFor(/seq 1 45/));
  c.send({ type: 'decide', id: sl.payload.id, decision: 'allow' });
  await c.waitFor('loop running', from, (e) => e.source === 'hook' && e.kind === 'PreToolUse' && /seq 1 45/.test(JSON.stringify(e.payload.body.tool_input)) && e.payload.response?.hookSpecificOutput?.permissionDecision === 'allow');
  await sleep(3000);
  const t0 = Date.now();
  const endedEarly = c.events.slice(from).some((e) => e.source === 'stream' && e.kind.startsWith('result'));
  c.send({ type: 'interrupt' });
  const interrupted = await c.waitFor('interrupted', from, isKind('session.interrupted'));
  await c.waitFor('turn end after interrupt', c.events.indexOf(interrupted), (e) => e.source === 'stream' && e.kind.startsWith('result'), 60_000);
  check('interrupt ends a running turn well before the 45 s command would', !endedEarly && Date.now() - t0 < 20_000, { endedEarly, ms: Date.now() - t0 });
  from = await say('Reply with just the word pong.');
  await turnEnd(from);
  check('the session still answers after an interrupt', /pong/i.test(lastReply(from)), lastReply(from).slice(0, 60));

  // 5. A message sent mid-turn reaches Claude before or right after the turn ends.
  from = await say('Run this exact shell command in the foreground (not in the background): `for i in $(seq 1 8); do sleep 1; done` and then reply with the word FIRST.');
  const s8 = await c.waitFor('loop approval', from, approvalFor(/seq 1 8/));
  c.send({ type: 'decide', id: s8.payload.id, decision: 'allow' });
  await sleep(2000);
  c.send({ type: 'send', text: 'Also include the word SECOND somewhere in your reply.' });
  await c.waitFor('mid-turn message delivered', from, isKind('steer.delivered'), 180_000);
  await turnEnd(from);
  // Delivered at the turn end means a second turn follows; wait for it to finish too.
  if (c.events.slice(from).filter((e) => e.source === 'stream' && e.kind.startsWith('result')).length < 2 && !/SECOND/.test(lastReply(from))) {
    await c.waitFor('second turn', from, (e) => e.source === 'stream' && e.kind.startsWith('result') && c.events.slice(from).filter((x) => x.kind.startsWith('result')).length >= 2, 180_000).catch(() => null);
  }
  check('a message sent mid-turn is acted on', /SECOND/.test(lastReply(from)), lastReply(from).slice(-160));
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  c.send({ type: 'config', phoneMuted: false });
  await sleep(300);
  c.close();
}

const failed = checks.filter((x) => !x.pass);
console.log(`\nGate phase 2: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
