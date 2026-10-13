import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WikiInfo } from '../shared/types.ts';

const run = promisify(execFile);

/** A wiki is a git repo with CLAUDE.md rules and a wiki/index.md (the knowledge-graph layout). */
/** A wiki's display name: the title of its CLAUDE.md ("# Anvil Digital Wiki — Schema & Operating Rules"). */
function titleOf(dir: string): string | null {
  try {
    const first = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').split('\n')[0];
    return first.replace(/^#\s*/, '').split(/\s+[—-]\s+/)[0].trim() || null;
  } catch {
    return null;
  }
}

const isWiki = (dir: string) => fs.existsSync(path.join(dir, 'CLAUDE.md')) && fs.existsSync(path.join(dir, 'wiki', 'index.md'));

export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'wiki';

function countPages(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'log.md') n++;
    }
  };
  try {
    walk(path.join(dir, 'wiki'));
  } catch {
    /* not there yet */
  }
  return n;
}

async function git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout, maxBuffer: 8_000_000 });
  return stdout.trim();
}

/**
 * The context wikis on the server, under one folder (hidden from the project list). Emits 'changed' when the
 * list or a wiki's status changes. Cloning, pulling and pushing use the server's GitHub login (gh).
 */
export class Wikis extends EventEmitter {
  readonly root: string;
  /** Wikis being cloned or built, and ones that failed, by id. */
  private status = new Map<string, Pick<WikiInfo, 'status' | 'detail'> & { name?: string }>();

  constructor(root: string) {
    super();
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  pathOf(id: string): string {
    return path.join(this.root, id);
  }

  list(): WikiInfo[] {
    const ids = new Set([...fs.readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name), ...this.status.keys()]);
    const out: WikiInfo[] = [];
    for (const id of [...ids].sort()) {
      const dir = this.pathOf(id);
      const s = this.status.get(id);
      if (!s && !isWiki(dir)) continue;
      out.push({
        id,
        name: s?.name ?? titleOf(dir) ?? id,
        path: dir,
        remote: this.remoteOf(dir),
        status: s?.status ?? 'ready',
        ...(s?.detail && { detail: s.detail }),
        pages: countPages(dir),
      });
    }
    return out;
  }

  ids(): Set<string> {
    return new Set(this.list().map((w) => w.id));
  }

  /** Clones a GitHub repo ("owner/name") as a wiki, or pulls it if it's already here. */
  async add(repo: string): Promise<string> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Give the repo as owner/name, e.g. your-name/company-wiki.');
    const id = slug(repo.split('/')[1]);
    const dir = this.pathOf(id);
    if (fs.existsSync(dir)) {
      await this.pull(id);
      return id;
    }
    this.set(id, { status: 'working', detail: `Cloning ${repo}…`, name: repo.split('/')[1] });
    try {
      await run('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir], { timeout: 300_000 });
      if (!isWiki(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`${repo} isn't a context wiki: it has no CLAUDE.md and wiki/index.md.`);
      }
      this.status.delete(id);
      this.emit('changed');
      return id;
    } catch (err) {
      this.set(id, { status: 'error', detail: String((err as { stderr?: string }).stderr || (err as Error).message).split('\n')[0] });
      throw err;
    }
  }

  /** Brings a linked wiki up to date before a session reads it. Failures leave the copy as it was. */
  async pull(id: string): Promise<void> {
    const dir = this.pathOf(id);
    if (!this.remoteOf(dir)) return;
    try {
      await git(dir, ['pull', '--ff-only', '--quiet']);
    } catch {
      /* offline or diverged: keep reading the local copy */
    }
  }

  /** Sets up a new wiki folder from the template, with a first source to ingest. */
  scaffold(name: string, subject: string, sourceName: string, source: string): string {
    let id = slug(name);
    for (let i = 2; fs.existsSync(this.pathOf(id)); i++) id = `${slug(name)}-${i}`;
    const dir = this.pathOf(id);
    for (const d of ['raw/inbox', 'raw/processed', 'raw/assets', 'wiki/sources']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd(name, subject));
    fs.writeFileSync(path.join(dir, 'wiki/index.md'), `# ${name}\n\nCatalog of every page, one line each, grouped by type.\n`);
    fs.writeFileSync(path.join(dir, 'wiki/log.md'), `# Log\n\nAppend only, newest at the bottom.\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'outputs/\n');
    fs.writeFileSync(path.join(dir, 'raw/inbox', sourceName), source);
    this.set(id, { status: 'working', detail: 'Setting up…', name });
    return id;
  }

  async initRepo(id: string): Promise<void> {
    const dir = this.pathOf(id);
    await git(dir, ['init', '--quiet', '-b', 'main']);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'init: wiki scaffold and first source']);
  }

  /** Deletes the server's copy (a wiki on GitHub keeps its repo there). Emits 'removed' so every project unlinks it. */
  remove(id: string): boolean {
    const dir = this.pathOf(id);
    if (!/^[\w.-]+$/.test(id) || this.status.get(id)?.status === 'working' || !fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    this.status.delete(id);
    this.emit('removed', id);
    this.emit('changed');
    return true;
  }

  /** Commits anything left uncommitted (a builder that forgot), so nothing is lost. */
  async commitAll(id: string, message: string): Promise<void> {
    const dir = this.pathOf(id);
    await git(dir, ['add', '-A']);
    const staged = await git(dir, ['diff', '--cached', '--name-only']);
    if (staged) await git(dir, ['commit', '--quiet', '-m', message]);
  }

  /** Creates the private GitHub repo and pushes. Returns its URL. */
  async publish(id: string): Promise<string> {
    const dir = this.pathOf(id);
    const { stdout: owner } = await run('gh', ['api', 'user', '-q', '.login'], { timeout: 30_000 });
    await run('gh', ['repo', 'create', `${owner.trim()}/${id}`, '--private', '--source', dir, '--remote', 'origin', '--push'], { timeout: 120_000 });
    return `https://github.com/${owner.trim()}/${id}`;
  }

  set(id: string, s: Partial<Pick<WikiInfo, 'status' | 'detail'>> & { name?: string }): void {
    this.status.set(id, { status: 'working', ...this.status.get(id), ...s });
    this.emit('changed');
  }

  done(id: string): void {
    this.status.delete(id);
    this.emit('changed');
  }

  private remoteOf(dir: string): string | null {
    try {
      const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
      const url = config.match(/\[remote "origin"\][^[]*?url = (.+)/)?.[1]?.trim();
      return url ? url.replace(/\.git$/, '') : null;
    } catch {
      return null;
    }
  }
}

/** The rules for a new wiki: a general knowledge-graph schema, with the subject the user gave. */
function claudeMd(name: string, subject: string): string {
  return `# ${name} — Schema & Operating Rules

You maintain this wiki. The human curates sources and asks questions; you do the
reading, writing, cross-linking, and upkeep. The human rarely edits wiki pages directly.

## Subject
${subject.trim() || 'Set by the human; ask if unclear.'}

## Layout

\`\`\`
raw/              Immutable source material. NEVER edit or delete anything here.
  inbox/          New, unprocessed sources land here.
  processed/      Move a source here after it has been ingested.
  assets/         Images/attachments referenced by sources.
wiki/             Everything you write lives here.
  index.md        Catalog of every page, one line each, grouped by type.
  log.md          Append-only activity log.
  sources/        One summary page per ingested source.
  decisions/      One page per significant decision (see rules).
  architecture/   Systems, services, infrastructure, integrations.
  initiatives/    Work in progress: status, deadlines, blockers.
  concepts/       Ideas, techniques, frameworks, terms.
  analyses/       Synthesized answers worth keeping.
outputs/          Throwaway renders. Gitignored.
\`\`\`

Add other folders under wiki/ when the subject needs them; record them here.

## Page conventions

- Filenames: lowercase-kebab-case.md. One subject per page.
- Every page starts with YAML frontmatter:
  \`\`\`yaml
  ---
  title: Human Readable Title
  type: source | decision | architecture | initiative | concept | analysis
  sources: [source-slug, ...]     # which source pages back this page
  updated: YYYY-MM-DD
  ---
  \`\`\`
- Link with Obsidian wikilinks: \`[[page-name]]\`. Link generously.
- Every factual claim should trace to a source page. Mark your own synthesis
  explicitly ("Synthesis:" or "Open question:").
- When sources disagree, don't pick silently. Add a \`## Contradictions\` section.
- Decisions are append-only history: date, context, options, choice, reasoning.
  A reversed decision gets a new page; the old one is marked superseded.

## Operations

### INGEST (trigger: "ingest", or files present in raw/inbox/)
For each new source:
1. Read it fully. Tell the human the 3–5 key takeaways; ask if any emphasis
   should change before writing (skip this if told "batch mode").
2. Write \`wiki/sources/<slug>.md\`: summary, key claims, short notable quotes,
   and links to every page it touches.
3. Create or update each touched page. Integrate new info into the existing text.
4. Update \`wiki/index.md\` and append to \`wiki/log.md\`.
5. Move the source from raw/inbox/ to raw/processed/.
6. \`git add -A && git commit -m "ingest: <slug>" && git push origin main\`

### QUERY (trigger: any question about the subject)
1. Read \`wiki/index.md\` first, then open relevant pages and follow links.
2. Answer with citations as wikilinks to the pages used.
3. If the answer is a non-trivial synthesis, offer to save it to \`wiki/analyses/\`.

### LINT (trigger: "lint" / "health check")
Report contradictions, unsourced claims, orphan pages and dangling links,
concepts lacking pages, stale pages and index mismatches; fix only what the
human approves.

## index.md format
\`\`\`
## Decisions
- [[page-slug]] — one-line description
\`\`\`

## log.md format
Append only, newest at bottom:
\`\`\`
## YYYY-MM-DD — ingest | query | lint | edit
- what changed, which pages
\`\`\`

## Hard rules
- Never modify raw/ contents (moving inbox → processed is the only exception).
- Never delete a wiki page without asking.
- Prefer editing existing pages over creating near-duplicates; check index.md first.
`;
}
