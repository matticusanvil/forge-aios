import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL_LEVELS, DEFAULT_RULES, MODELS, type Rules } from '../shared/types.ts';
import type { EventLog } from './eventlog.ts';

const MODEL_IDS = new Set<string>(MODELS.map((m) => m.id));

const limit = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  return Number.isInteger(v) && (v as number) > 0 && (v as number) <= 20 ? (v as number) : undefined;
};

/** Keeps only valid fields from what the browser sent, so a bad value can't land in the rules. */
export function sanitize(raw: Partial<Rules>, wikiIds: Set<string>): Partial<Rules> {
  const out: Partial<Rules> = {};
  if ('mainModel' in raw) out.mainModel = raw.mainModel && MODEL_IDS.has(raw.mainModel) ? raw.mainModel : null;
  if (raw.workerModel && MODEL_IDS.has(raw.workerModel)) out.workerModel = raw.workerModel;
  if ('maxRunning' in raw && limit(raw.maxRunning) !== undefined) out.maxRunning = limit(raw.maxRunning)!;
  if (raw.maxByModel && typeof raw.maxByModel === 'object') {
    out.maxByModel = {};
    for (const [m, v] of Object.entries(raw.maxByModel)) if (MODEL_IDS.has(m) && limit(v) !== undefined) out.maxByModel[m] = limit(v)!;
  }
  if (typeof raw.autoAllowReadOnly === 'boolean') out.autoAllowReadOnly = raw.autoAllowReadOnly;
  if (APPROVAL_LEVELS.some((l) => l.id === raw.approvals)) out.approvals = raw.approvals;
  if (typeof raw.phone === 'boolean') out.phone = raw.phone;
  if (Number.isFinite(raw.finishedPushAfterMin) && raw.finishedPushAfterMin! >= 0 && raw.finishedPushAfterMin! <= 240) out.finishedPushAfterMin = raw.finishedPushAfterMin;
  if (Array.isArray(raw.wikis)) out.wikis = [...new Set(raw.wikis.filter((w) => typeof w === 'string' && wikiIds.has(w)))];
  return out;
}

/** Defaults for every project live in /data/defaults.json; each project's current session rules live in its database. */
export class RulesStore {
  private file: string;
  private store: EventLog;

  constructor(dataDir: string, store: EventLog) {
    this.file = path.join(dataDir, 'defaults.json');
    this.store = store;
  }

  defaults(): Rules {
    try {
      return { ...DEFAULT_RULES, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      return { ...DEFAULT_RULES };
    }
  }

  setDefaults(patch: Partial<Rules>): Rules {
    const next = { ...this.defaults(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  /** The current session's rules; before rules existed, the older single settings are carried over. */
  session(): Rules {
    const saved = this.store.getMeta('rules');
    if (saved) return { ...this.defaults(), ...JSON.parse(saved) };
    const legacy: Partial<Rules> = {};
    const cap = this.store.getMeta('maxRunning');
    if (cap) legacy.maxRunning = Number(cap);
    const model = this.store.getMeta('mainModel');
    if (model) legacy.mainModel = model;
    return { ...this.defaults(), ...legacy };
  }

  setSession(rules: Rules): void {
    this.store.setMeta('rules', JSON.stringify(rules));
  }
}
