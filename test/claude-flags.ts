// Checks that the installed Claude Code still has every command-line flag Forge uses (read from server/session.ts),
// and the subcommands Forge calls. No sign-in needed. Run by the weekly compatibility workflow against the newest Claude Code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { CLAUDE } from '../server/config.ts';

const source = fs.readFileSync(new URL('../server/session.ts', import.meta.url), 'utf8');
const flags = [...new Set(source.match(/'--[a-zA-Z-]+'/g)?.map((f) => f.slice(1, -1)) ?? [])];
const help = execFileSync(CLAUDE, ['--help'], { encoding: 'utf8' });
const authHelp = execFileSync(CLAUDE, ['auth', '--help'], { encoding: 'utf8' });
const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim();

const missing = flags.filter((f) => !help.includes(f));
if (!/\bstatus\b/.test(authHelp)) missing.push('auth status');
console.log(`Claude Code ${version}: ${flags.length} flags checked${missing.length ? `, missing: ${missing.join(', ')}` : ', all present'}`);
process.exit(missing.length ? 1 : 0);
