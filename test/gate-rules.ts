// Gate for session rules, per-model limits, session names and context wikis.
// Usage: FORGE_URL=http://host:3200 node test/gate-rules.ts
// Starts new sessions, mutes phone pushes, builds a local test wiki (not pushed to GitHub), and restores the defaults it changes.
// The linked-wiki checks need a knowledge graph on GitHub and a question it answers; they're skipped unless these are set:
//   FORGE_TEST_WIKI=owner/name  FORGE_TEST_WIKI_QUESTION='…'  FORGE_TEST_WIKI_ANSWER='regex the reply must match'

import { authHeaders, Client, type Ev } from './client.ts';
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
const waitSession = (label: string, pred: (s: any) => boolean, ms = 60_000) => {
  const t = Date.now();
  return new Promise<any>((resolve, reject) => {
    const tick = () => (c.session && pred(c.session) ? resolve(c.session) : Date.now() - t > ms ? reject(new Error(`timed out waiting for ${label}`)) : setTimeout(tick, 250));
    tick();
  });
};
let decide: (a: any) => any = () => ({ decision: 'allow' });
async function say(text: string, ms = 300_000): Promise<number> {
  // Only from idle: a message sent mid-turn would be queued, and this turn's end would be the previous one's.
  await waitSession('main idle', (s) => !s.busy, ms);
  const from = c.events.length;
  c.send({ type: 'send', text });
  await c.waitFor('turn end', from, mainResult(from), ms);
  return from;
}
const counting = (l: string, n: number) => `Run these shell commands one at a time, each as its own Bash call: ${Array.from({ length: n }, (_, i) => `\`echo ${l}${i + 1} && sleep 2\``).join(', ')}. Then reply with the last line.`;

const originalDefaults = await (async () => { await sleep(500); return c.session?.defaults; })();

try {
  c.send({ type: 'config', phoneMuted: true });
  c.onEvent((e) => {
    if (e.kind === 'approval.requested') c.send({ type: 'decide', id: e.payload.id, ...decide(e.payload) });
  });

  // 1. Session name and defaults: a default carries into a new session, which gets the name you gave it.
  c.send({ type: 'setDefaults', rules: { workerModel: 'haiku', maxByModel: {} } });
  const sessionName = `Gate rules ${Date.now().toString(36)}`;
  c.send({ type: 'reset', approvals: 'ask', model: '', name: sessionName });
  const s1 = await waitSession('named session', (s) => s.sessionName === sessionName);
  check('a new session gets the name you gave it', s1.sessionName === sessionName);
  check('a new session starts from the defaults', s1.rules.workerModel === 'haiku' && s1.defaults.workerModel === 'haiku', { rules: s1.rules.workerModel });

  // 2. Per-model limit: Haiku at most 1. Two Haiku and one Sonnet launched together: one of each starts.
  c.send({ type: 'setRules', rules: { maxByModel: { haiku: 1 } } });
  await waitSession('haiku limit', (s) => s.rules.maxByModel.haiku === 1);
  let from = c.events.length;
  await say(
    'Launch three general-purpose subagents in parallel, in a single message, each with the model parameter set as given. ' +
      `"H1" on model haiku, task word for word: "${counting('H', 2)}" ` +
      `"H2" on model haiku, task word for word: "${counting('I', 2)}" ` +
      `"S1" on model sonnet, task word for word: "${counting('S', 2)}" ` +
      "If any launch is refused, don't retry it.",
  );
  await c.waitForAgents('spawned finished', (list) => list.filter((a) => a.kind === 'subagent').every((a) => a.endedAt), 240_000);
  const started = c.agents.filter((a) => a.kind === 'subagent');
  const refused = c.events.slice(from).filter((e) => e.kind === 'spawn.refused');
  check('the Haiku limit lets one Haiku start; Sonnet is unaffected',
    started.filter((a) => a.model === 'haiku').length === 1 && started.some((a) => a.model === 'sonnet') && refused.some((e) => e.payload.model === 'haiku'),
    { started: started.map((a) => `${a.description}:${a.model}`), refused: refused.map((e) => e.payload.model) });

  // 3. The same limit holds for Add agent: a second Haiku worker is refused while one runs; a Sonnet one starts.
  from = c.events.length;
  c.send({ type: 'addAgent', request: { mode: 'worker', name: 'Haiku long', model: 'haiku', task: counting('L', 8) } });
  await c.waitForAgents('haiku worker', (l) => l.some((a) => a.description === 'Haiku long'));
  c.send({ type: 'addAgent', request: { mode: 'worker', name: 'Haiku two', model: 'haiku', task: 'Reply OK' } });
  c.send({ type: 'addAgent', request: { mode: 'worker', name: 'Sonnet one', model: 'sonnet', task: 'Reply with just OK' } });
  const blocked = await c.waitFor('agent.refused', from, (e) => e.kind === 'agent.refused', 20_000).catch(() => null);
  const sonnet = await c.waitForAgents('sonnet worker', (l) => l.some((a) => a.description === 'Sonnet one'), 20_000).then(() => true, () => false);
  check('Add agent obeys the per-model limit', !!blocked && /Haiku/.test(blocked.payload.reason ?? '') && sonnet, { reason: blocked?.payload.reason, sonnet });
  for (const a of c.agents.filter((x) => x.kind === 'worker' && !x.endedAt)) c.send({ type: 'closeAgent', agentId: a.agentId });
  c.send({ type: 'setRules', rules: { maxByModel: {} } });

  // 4. Read-only tools off: a Read asks. Then remove a session rule.
  c.send({ type: 'setRules', rules: { autoAllowReadOnly: false } });
  await waitSession('read-only off', (s) => !s.rules.autoAllowReadOnly);
  const asked: string[] = [];
  decide = (a) => {
    asked.push(a.summary);
    return a.summary.startsWith('Bash: cat') ? { decision: 'allow-session' } : { decision: 'allow' };
  };
  await say('Read README.md with the Read tool, then run `cat README.md` in the shell, and reply with its first line.');
  check('with auto-allow off, a Read asks first', asked.some((x) => x.startsWith('Read:')), asked);
  c.send({ type: 'setRules', rules: { autoAllowReadOnly: true } });
  await sleep(500);
  c.send({ type: 'removeRule', key: 'bash:cat' });
  await sleep(1000);
  const state = await fetch(`${BASE}/api/state`, { headers: authHeaders() }).then((r) => r.json());
  check('a session rule can be removed', !state.rules.some((r: any) => r.key === 'bash:cat'), state.rules);
  decide = () => ({ decision: 'allow' });

  // 4b. Approval levels: at "Trusted project", look-around commands and edits inside the project run without asking; rm still asks.
  c.send({ type: 'setRules', rules: { approvals: 'project' } });
  await waitSession('trusted project', (s) => s.rules.approvals === 'project');
  const levelAsked: string[] = [];
  decide = (a) => (levelAsked.push(a.summary), { decision: 'allow' });
  const tmp = `level-${Date.now().toString(36)}.txt`;
  await say(`Do these in order, one tool call each: run \`ls\`; run \`git status\`; create ${tmp} containing "ok" with the Write tool; run \`rm ${tmp}\`. Then reply DONE.`);
  check('at Trusted project, ls, git status and a project edit run without asking; rm still asks', levelAsked.length > 0 && levelAsked.every((x) => x.startsWith('Bash: rm')), levelAsked);
  c.send({ type: 'setRules', rules: { approvals: 'ask' } });
  await waitSession('back to ask', (s) => s.rules.approvals === 'ask');
  decide = () => ({ decision: 'allow' });

  // 5. Link a wiki: Claude answers from it, and it stays read only.
  const wikiRepo = process.env.FORGE_TEST_WIKI;
  if (wikiRepo && process.env.FORGE_TEST_WIKI_QUESTION && process.env.FORGE_TEST_WIKI_ANSWER) {
    const wikiId = wikiRepo.split('/')[1].toLowerCase();
    from = c.events.length;
    c.send({ type: 'wikiAdd', repo: wikiRepo });
    const linked = await waitSession('wiki linked', (s) => s.rules.wikis.includes(wikiId) && s.wikis.find((w: any) => w.id === wikiId)?.status === 'ready', 300_000);
    const wiki = linked.wikis.find((w: any) => w.id === wikiId);
    check('a GitHub wiki is cloned and linked', !!wiki && wiki.pages > 0, { pages: wiki?.pages, remote: wiki?.remote });
    await c.waitFor('restart for the wiki', from, (e) => e.kind === 'session.restarted', 30_000).catch(() => null);
    from = await say(`Using the linked context wiki: ${process.env.FORGE_TEST_WIKI_QUESTION} Answer in one line and name the wiki page you used.`);
    check('Claude answers from the linked wiki', new RegExp(process.env.FORGE_TEST_WIKI_ANSWER, 'i').test(mainReply(from)), mainReply(from).slice(0, 200));
    from = await say('Append the line "- gate test" to the end of wiki/index.md in the linked context wiki, using the Edit tool. If you are not allowed, say so.');
    const wroteWiki = c.events.slice(from).some((e) => e.source === 'hook' && e.kind === 'PostToolUse' && /Edit|Write/.test(e.payload.body?.tool_name) && String(e.payload.body?.tool_input?.file_path).includes(`/.wikis/${wikiId}/`));
    check('the linked wiki stays read only', !wroteWiki, mainReply(from).slice(0, 160));
  } else {
    console.log('SKIP  linked-wiki checks (set FORGE_TEST_WIKI, FORGE_TEST_WIKI_QUESTION and FORGE_TEST_WIKI_ANSWER to run them)');
  }

  // 6. Create a wiki from this session (kept on the server for the test, not pushed).
  from = c.events.length;
  const name = `Gate wiki ${Date.now().toString(36)}`;
  c.send({ type: 'wikiCreate', name, subject: 'A test wiki made by the Forge AIOS rules gate.', publish: false });
  const done = await c.waitFor('wiki created', from, (e) => e.kind === 'wiki.created' || e.kind === 'wiki.error', 600_000);
  if (done.kind === 'wiki.created') await waitSession('new wiki linked', (s) => s.rules.wikis.includes(done.payload.id), 30_000).catch(() => null);
  const made = c.session.wikis.find((w: any) => w.name === name || w.id === done.payload.id);
  check('a wiki is created from this session, ingested and linked', done.kind === 'wiki.created' && (made?.pages ?? 0) >= 1 && c.session.rules.wikis.includes(done.payload.id),
    { event: done.kind, message: done.payload.message, pages: made?.pages });
} catch (err) {
  check('gate ran to the end', false, String(err));
} finally {
  // The test wiki is local only; remove it so runs don't pile up in your wiki list.
  for (const w of c.session?.wikis ?? []) if (/^gate-wiki-/.test(w.id) && !w.remote) c.send({ type: 'wikiRemove', id: w.id });
  if (originalDefaults) c.send({ type: 'setDefaults', rules: originalDefaults });
  c.send({ type: 'setRules', rules: { wikis: [], maxByModel: {}, autoAllowReadOnly: true } });
  c.send({ type: 'config', phoneMuted: false });
  await sleep(800);
  c.close();
}
const failed = checks.filter((x) => !x.pass);
console.log(`\nGate rules: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
