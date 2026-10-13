// Fast tests for the approval rules: no server, no Claude.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { commandPrefix, commandSegments, isInside, Permissions, rulesFor, trustedCommand } from '../../server/permissions.ts';

const DIR = '/srv/repos/demo';

// A stand-in for the project database: only the session rules matter here.
function permissions(level: 'ask' | 'project' | 'all', rules: string[] = [], dir = DIR, paths = path.posix) {
  const store = { rules: () => rules.map((key) => ({ key, label: key })), addRule() {}, clearRules() {}, removeRule() {} };
  const p = new Permissions({ store: store as any, record: () => {}, projectDir: dir, paths });
  p.level = level;
  return p;
}
/** True when the call goes ahead without a card; a card (a pending Promise) counts as asking. */
function allowed(p: Permissions, tool: string, input: Record<string, unknown>): boolean | 'denied' {
  const v = p.check(null, tool, input);
  if (v instanceof Promise) {
    p.denyAll('reset', 'test over');
    return false;
  }
  return v.decision === 'allow' ? true : 'denied';
}

test('commands split on && || ; | and newlines', () => {
  assert.deepEqual(commandSegments('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('a command prefix keeps the subcommand for programs that have one', () => {
  assert.equal(commandPrefix('git status -s'), 'git status');
  assert.equal(commandPrefix('FOO=1 npm test'), 'npm test');
  assert.equal(commandPrefix('ls -la'), 'ls');
  assert.equal(commandPrefix('node --version'), 'node');
});

test('session rules: one per command, one for all edits', () => {
  assert.deepEqual([...rulesFor('Bash', { command: 'git add . && git commit -m x' }).keys()], ['bash:git add', 'bash:git commit']);
  assert.deepEqual([...rulesFor('Write', { file_path: 'a.txt' }).keys()], ['edits']);
});

const trusted: [string, boolean][] = [
  ['ls -la', true],
  ['cat src/a.ts | head -20', true],
  ['git status && git diff', true],
  ['grep -rn foo src 2>/dev/null', true],
  ['npm test', true],
  ['npm run build 2>&1 | tail -5', true],
  ['npx tsc --noEmit', true],
  ['mkdir -p src/lib && touch src/lib/x.ts', true],
  ['git add -A && git commit -m "x"', true],
  [`ls ${DIR}/src`, true],
  ['git log --oneline HEAD~3..HEAD', true],
  ['rm -rf dist', false],
  ['git push', false],
  ['curl https://example.com', false],
  ['cat /etc/passwd', false],
  ['cat ../other/secret', false],
  ['cat ~/.ssh/id_rsa', false],
  ['echo hi > file.txt', false],
  ['find . -name x -delete', false],
  ['ls $(pwd)/..', false],
  ['ls && rm x', false],
  ['sudo ls', false],
  ['docker ps', false],
  ['npm publish', false],
];
for (const [command, expected] of trusted) {
  test(`Trusted project ${expected ? 'allows' : 'asks for'}: ${command}`, () => {
    assert.equal(trustedCommand(command, DIR, true), expected);
  });
}

test('Ask: shell commands and edits ask; read-only and bookkeeping tools do not', () => {
  const p = permissions('ask');
  assert.equal(allowed(p, 'Bash', { command: 'ls' }), false);
  assert.equal(allowed(p, 'Write', { file_path: `${DIR}/a.txt` }), false);
  assert.equal(allowed(p, 'Read', { file_path: `${DIR}/a.txt` }), true);
  assert.equal(allowed(p, 'TaskUpdate', {}), true);
});

test('Ask: a session rule lets a command through', () => {
  assert.equal(allowed(permissions('ask', ['bash:npm test']), 'Bash', { command: 'npm test' }), true);
});

test('Trusted project: edits inside the project run, outside or in .git they ask', () => {
  const p = permissions('project');
  assert.equal(allowed(p, 'Edit', { file_path: `${DIR}/src/a.ts` }), true);
  assert.equal(allowed(p, 'Write', { file_path: 'notes/plan.md' }), true);
  assert.equal(allowed(p, 'Write', { file_path: '/etc/hosts' }), false);
  assert.equal(allowed(p, 'Write', { file_path: `${DIR}/../other/a.ts` }), false);
  assert.equal(allowed(p, 'Write', { file_path: `${DIR}/.git/config` }), false);
  assert.equal(allowed(p, 'WebFetch', { url: 'https://example.com' }), false);
});

test('Allow everything: nothing asks, but linked wikis stay read only', () => {
  const p = permissions('all');
  p.readOnlyDirs = ['/srv/repos/.wikis/kg'];
  assert.equal(allowed(p, 'Bash', { command: 'rm -rf dist' }), true);
  assert.equal(allowed(p, 'Edit', { file_path: '/srv/repos/.wikis/kg/wiki/index.md' }), 'denied');
});

test('AskUserQuestion is refused with a reason at every level', () => {
  for (const level of ['ask', 'project', 'all'] as const) assert.equal(allowed(permissions(level), 'AskUserQuestion', {}), 'denied');
});

// Windows: Claude Code passes C:\ paths to file tools; Git Bash commands may write C:\, C:/ or /c/.
const WIN = 'C:\\Users\\me\\proj';

test('Windows paths: inside the project, case and slashes aside', () => {
  assert.equal(isInside('c:/users/ME/proj/src/a.ts', WIN, path.win32), true);
  assert.equal(isInside('C:\\Users\\me\\project2\\a.ts', WIN, path.win32), false);
  assert.equal(isInside('D:\\proj\\a.ts', WIN, path.win32), false);
});

const trustedWin: [string, boolean][] = [
  ['ls src', true],
  ['cat /c/Users/me/proj/README.md', true],
  ['cat C:/Users/me/proj/README.md', true],
  ['git status 2>NUL', true],
  ['cat /c/Users/me/other/secret.txt', false],
  ['cat C:\\Windows\\win.ini', false],
  ['type ..\\other\\secret.txt', false],
  ['cat /etc/passwd', false],
  ['npm test', true],
  ['rm -rf dist', false],
];
for (const [command, expected] of trustedWin) {
  test(`Trusted project on Windows ${expected ? 'allows' : 'asks for'}: ${command}`, () => {
    assert.equal(trustedCommand(command, WIN, true, path.win32), expected);
  });
}

test('Trusted project on Windows: edits inside the project run, elsewhere they ask', () => {
  const p = permissions('project', [], WIN, path.win32);
  assert.equal(allowed(p, 'Edit', { file_path: 'C:\\Users\\me\\proj\\src\\a.ts' }), true);
  assert.equal(allowed(p, 'Write', { file_path: 'src/new.ts' }), true);
  assert.equal(allowed(p, 'Write', { file_path: 'C:\\Users\\me\\proj\\.git\\config' }), false);
  assert.equal(allowed(p, 'Write', { file_path: 'C:\\Users\\me\\Desktop\\a.txt' }), false);
});
