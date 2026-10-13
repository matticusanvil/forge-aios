// Consistent copies of Forge's data, for deploy/forge-backup.sh: every project database (VACUUM INTO, safe while
// running), the rules defaults and the sign-in file. Usage, inside the container: node server/backup.ts <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = process.env.FORGE_DATA ?? '/data';
const out = process.argv[2];
if (!out) throw new Error('usage: node server/backup.ts <out-dir>');
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(DATA)) {
  const file = path.join(DATA, name);
  if (name.endsWith('.db')) {
    const db = new DatabaseSync(file);
    db.exec(`VACUUM INTO '${path.join(out, name).replace(/'/g, "''")}'`);
    db.close();
  } else if (name.endsWith('.json')) {
    fs.copyFileSync(file, path.join(out, name));
  }
}
console.log(`backed up ${fs.readdirSync(out).length} files to ${out}`);
