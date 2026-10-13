// Gathers what the installer ships besides the app itself: Forge (server, built web app, production
// dependencies) in build/forge, and the Node runtime it's tested on in build/node, checked against nodejs.org's checksums.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.23.3';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(here, 'build');
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
const forge = path.join(out, 'forge');
fs.mkdirSync(forge, { recursive: true });

if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) sh('npm run build', root);
for (const item of ['server', 'shared', 'web/dist', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE']) {
  fs.cpSync(path.join(root, item), path.join(forge, item), { recursive: true });
}
sh('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', forge);

const nodeDir = path.join(out, 'node');
fs.mkdirSync(nodeDir, { recursive: true });
const base = `https://nodejs.org/dist/${NODE_VERSION}`;
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const expected = sums.split('\n').find((l) => l.endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
const exe = Buffer.from(await (await fetch(`${base}/win-x64/node.exe`)).arrayBuffer());
const actual = createHash('sha256').update(exe).digest('hex');
if (!expected || actual !== expected) throw new Error(`node.exe checksum mismatch: expected ${expected}, got ${actual}`);
fs.writeFileSync(path.join(nodeDir, 'node.exe'), exe);
fs.writeFileSync(path.join(nodeDir, 'LICENSE'), await (await fetch(`https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/LICENSE`)).text());
console.log(`Prepared Forge and Node ${NODE_VERSION} in ${out}`);
