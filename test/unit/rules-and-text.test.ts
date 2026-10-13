// Fast tests for session-rule checking and the text helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitize } from '../../server/rules.ts';
import { oneLine, plainText, redact, toolSummary } from '../../shared/text.ts';

test('rules keep valid values and drop the rest', () => {
  const out = sanitize({ approvals: 'project', maxRunning: 3, autoAllowReadOnly: false, wikis: ['kg', 'nope'] } as any, new Set(['kg']));
  assert.deepEqual(out, { approvals: 'project', maxRunning: 3, autoAllowReadOnly: false, wikis: ['kg'] });
  assert.deepEqual(sanitize({ approvals: 'yolo', maxRunning: 99, workerModel: 'gpt' } as any, new Set()), {});
});

test('a limit of null means no limit', () => {
  assert.deepEqual(sanitize({ maxRunning: null } as any, new Set()), { maxRunning: null });
});

test('tool summaries are one line', () => {
  assert.equal(toolSummary('Bash', { command: 'npm\n  test' }), 'Bash: npm test');
  assert.equal(toolSummary('Read', { file_path: 'src/a.ts' }), 'Read: src/a.ts');
  assert.equal(oneLine('x'.repeat(300)).length, 200);
});

test('markdown flattens to plain words', () => {
  assert.equal(plainText('## Done\n- **Fixed** the [bug](http://x) in `a.ts`'), 'Done\nFixed the bug in a.ts');
});

test('secrets are hidden before they are shown', () => {
  const fake = 'x'.repeat(16); // built at runtime, so secret scanners don't flag the test itself
  assert.ok(!redact(`Authorization: Bearer ${fake}`).includes(fake));
  assert.equal(redact('API_KEY=supersecretvalue123'), 'API_KEY=***');
  assert.equal(redact('git clone https://user:pass123@github.com/x/y'), 'git clone https://user:***@github.com/x/y');
  assert.equal(redact('src/components/Button.tsx'), 'src/components/Button.tsx');
});
