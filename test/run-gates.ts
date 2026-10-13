// Runs the nine live gate tests in order against a Forge AIOS server (FORGE_URL) and prints a summary.
// They start new sessions in the playground and playground-b projects, so don't run them while you're working there.
import { spawnSync } from 'node:child_process';

const GATES = ['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'agents', 'extras', 'rules'];
const results: string[] = [];
for (const gate of GATES) {
  console.log(`\n=== ${gate}`);
  const run = spawnSync(process.execPath, [`test/gate-${gate}.ts`, ...process.argv.slice(2)], { stdio: 'inherit' });
  results.push(`${run.status === 0 ? 'PASS' : 'FAIL'}  ${gate}`);
}
console.log(`\n${results.join('\n')}`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
