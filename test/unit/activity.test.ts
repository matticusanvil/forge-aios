// Fast tests for the activity view's paths: Linux and Windows projects alike.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectPath } from '../../web/src/activity.ts';

test('a file inside the project becomes relative to it', () => {
  assert.equal(projectPath('/srv/repos/demo/src/a.ts', '/srv/repos/demo'), 'src/a.ts');
  assert.equal(projectPath('/srv/repos/demo/src/a.ts', '/srv/repos/demo/'), 'src/a.ts');
});

test('a file elsewhere stays absolute', () => {
  assert.equal(projectPath('/etc/hosts', '/srv/repos/demo'), '/etc/hosts');
  assert.equal(projectPath('/srv/repos/demo2/a.ts', '/srv/repos/demo'), '/srv/repos/demo2/a.ts');
});

test('on Windows, either slash and any case, with / in the result as git writes it', () => {
  const root = 'C:\\Users\\me\\proj';
  assert.equal(projectPath('C:\\Users\\me\\proj\\src\\a.ts', root), 'src/a.ts');
  assert.equal(projectPath('c:/users/ME/proj/README.md', root), 'README.md');
  assert.equal(projectPath('C:\\Users\\me\\other\\a.ts', root), 'C:/Users/me/other/a.ts');
});
