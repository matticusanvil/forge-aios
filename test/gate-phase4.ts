// Phase 4 gate: the activity view (files touched, git diff, timeline) updates live and links back to the chat.
// Usage: FORGE_URL=http://host:3200 node test/gate-phase4.ts
// Main reads a file and writes one; a subagent edits it. Starts a new session; mutes phone pushes; writes notes/plan-*.md in the project.

import { fileRows, lanes, sessionEvents, touches } from '../web/src/activity.ts';
import { BASE } from './config.ts';
import { buildChat } from '../web/src/chat.ts';
import { Client, type Ev } from './client.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Check = { name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};

const FILE = `notes/plan-${Date.now().toString(36)}.md`;
const c = await Client.open(`${BASE.replace(/^http/, 'ws')}/ws`);
const mainResult = (from: number) => (e: Ev) => e.source === 'stream' && e.kind.startsWith('result') && !e.agentId && c.events.indexOf(e) >= from;

try {
  c.send({ type: 'config', phoneMuted: true });
  c.send({ type: 'reset', approvals: 'ask' });
  await sleep(1500);
  c.onEvent((e) => {
    if (e.kind === 'approval.requested') c.send({ type: 'decide', id: e.payload.id, decision: 'allow' });
  });
  const gitBefore = c.git?.files?.length ?? 0;

  const from = c.events.length;
  c.send({
    type: 'send',
    text: `Read README.md. Then create ${FILE} containing exactly two lines: "Plan A" and "Plan B". Then launch one general-purpose subagent in the foreground ` +
      `with the description "Editor" and this task word for word: "Use the Edit tool to change the line Plan B to Plan C in ${FILE}. Then reply done." ` +
      'When it returns, reply with one line.',
  });
  await c.waitFor('turn end', from, mainResult(from), 300_000);
  await c.waitForAgents('editor finished', (list) => list.some((a) => a.description === 'Editor' && a.endedAt), 120_000);
  await sleep(2500); // the git watcher settles after the last tool call

  const editor = c.agents.find((a) => a.description === 'Editor');
  const project = c.session.project;
  const events = sessionEvents(c.events);

  // Git diff: the new file, with its two lines.
  const g = c.git?.files?.find((f: any) => f.file === FILE);
  check('git diff shows the new file live', !!g && g.added === 2, { g, files: c.git?.files?.length, before: gitBefore });

  // File tree: who touched what, and who touched it last.
  const rows = fileRows(touches(events, project), c.git, Date.now());
  const readme = rows.find((r) => r.path === 'README.md');
  const plan = rows.find((r) => r.path === FILE);
  check('the tree shows README.md read by main', !!readme && readme.touches.some((t) => t.agentId === null && t.kind === 'read'), readme?.touches.map((t) => [t.tool, t.agentId]));
  check('the tree shows the plan written by main, then edited by the subagent', !!plan && plan.touches.some((t) => t.agentId === null && t.kind === 'write') && plan.lastAgent === editor?.agentId && plan.heat === 1,
    { touches: plan?.touches.map((t) => [t.tool, t.agentId]), last: plan?.lastAgent, heat: plan?.heat });

  // Timeline: a lane per agent, ticks for tool calls, approval marks.
  const tl = lanes(events, c.agents, project);
  const mainLane = tl.find((l) => l.agentId === null)!;
  const editorLane = tl.find((l) => l.agentId === editor?.agentId);
  check('the timeline has a lane each for main and the subagent, with their tool calls', mainLane.ticks.length >= 3 && (editorLane?.ticks.length ?? 0) >= 1,
    { main: mainLane.ticks.map((t) => t.tool), editor: editorLane?.ticks.map((t) => t.tool) });
  check('your approvals are marked on the lanes (allowed ones as ALLOWED)', mainLane.marks.some((m) => m.kind === 'allowed'),
    [...mainLane.marks, ...(editorLane?.marks ?? [])].map((m) => m.kind));

  // Linking: every tick and every file-history entry lands on a real item in the chat or the subagent's feed.
  const ids = new Map<string | null, Set<string>>();
  const idsFor = (scope: string | null) => {
    if (!ids.has(scope)) ids.set(scope, new Set(buildChat(c.events, scope).map((i) => i.id)));
    return ids.get(scope)!;
  };
  const ticks = tl.flatMap((l) => l.ticks);
  const lostTicks = ticks.filter((t) => !idsFor(t.jump.scope).has(t.jump.id));
  check('every timeline tick jumps to its chat item', ticks.length > 0 && lostTicks.length === 0, { ticks: ticks.length, lost: lostTicks.map((t) => t.tool) });
  const history = rows.flatMap((r) => r.touches);
  const lostHistory = history.filter((t) => !idsFor(t.agentId).has(t.toolUseId));
  check('every file-history entry jumps to its chat item', history.length > 0 && lostHistory.length === 0, { entries: history.length, lost: lostHistory.length });
  const markJumps = tl.flatMap((l) => l.marks).filter((m) => m.jump);
  const lostMarks = markJumps.filter((m) => !idsFor(m.jump!.scope).has(m.jump!.id));
  check('approval and note marks jump to their chat item', lostMarks.length === 0, { marks: markJumps.length, lost: lostMarks.map((m) => m.kind) });
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  c.send({ type: 'config', phoneMuted: false });
  await sleep(300);
  c.close();
}
const failed = checks.filter((x) => !x.pass);
console.log(`\nGate phase 4: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
