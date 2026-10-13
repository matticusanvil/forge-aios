// After the installer is signed its bytes change, so latest.yml (what auto-update checks) needs the new size and hash.
// Usage: node update-latest.mjs dist/Forge-AIOS-Setup-x.y.z.exe dist/latest.yml
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const [exe, yml] = process.argv.slice(2);
const bytes = fs.readFileSync(exe);
const sha512 = createHash('sha512').update(bytes).digest('base64');
const updated = fs.readFileSync(yml, 'utf8')
  .replace(/(sha512: ).*/g, `$1${sha512}`)
  .replace(/(size: ).*/g, `$1${bytes.length}`);
fs.writeFileSync(yml, updated);
console.log(`latest.yml: ${bytes.length} bytes, sha512 ${sha512.slice(0, 16)}…`);
