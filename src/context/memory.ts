// Learnings reported by workers, stored as JSONL in the project data dir (see paths.ts).
//
// The file is an append-only log of sightings: `add` only appends, so concurrent runs on clones of one
// repository never lose each other's lines, and `load` folds the log into one entry per learning. Two
// sightings are the same learning when their ids match (normalised text) or their wording overlaps
// enough (see `similar`), which is how paraphrases from different workers collapse.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CliError } from '../errors.ts';
import { STATE_DIR, type Config, type MemoryConfig } from '../config.ts';
import { projectDataDir } from '../paths.ts';
import type { HarnessName } from '../types.ts';

export interface Learning {
  id: string;
  text: string;
  /** Repo-relative paths this learning is about. */
  files: string[];
  runId: string;
  cardId: string;
  harness: HarnessName;
  createdAt: string;
  lastSeenAt: string;
  seen: number;
}

export type NewLearning = Pick<Learning, 'text' | 'files' | 'runId' | 'cardId' | 'harness'>;

export interface SelectOptions {
  runId?: string;
  files?: string[];
  /** Learnings whose files are all missing under root are skipped. */
  root?: string;
  maxItems?: number;
  maxChars?: number;
}

export interface MemoryStore {
  path: string;
  load(): Learning[];
  /** Returns the entries that were new (duplicates are merged). */
  add(entries: NewLearning[]): Learning[];
  remove(id: string): boolean;
  /** Drop learnings whose files are all gone and rewrite the log folded (`merged` = sightings collapsed). */
  compact(root: string): { kept: number; dropped: Learning[]; merged: number };
  /** Best first, within the configured budget. */
  select(opts?: SelectOptions): Learning[];
}

export function memoryPath(repoRoot: string, cfg: MemoryConfig): string {
  if (cfg.location === 'repo') return join(repoRoot, STATE_DIR, 'memory.jsonl');
  return join(projectDataDir(repoRoot), 'memory.jsonl');
}

// ---- helpers ----

export function learningId(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!]+$/g, '').trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

const PATH_RE = /(?<![\w/])(?:[\w@.-]+\/)+[\w@.-]+|(?<![\w/.])[\w-]+\.[A-Za-z]{1,6}(?![\w/])/g;

/** Paths mentioned in text that exist under root. */
export function extractPaths(text: string, root: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(PATH_RE) ?? []) {
    const p = m.replace(/^\.\//, '').replace(/[.,:;)]+$/, '');
    if (!p || isAbsolute(p) || p.includes('..') || p.endsWith('/')) continue;
    if (existsSync(join(root, p))) out.add(p);
  }
  return [...out];
}

function parse(line: string): Learning | undefined {
  try {
    const o = JSON.parse(line) as Partial<Learning>;
    if (typeof o.text !== 'string' || typeof o.id !== 'string') return undefined;
    return {
      id: o.id, text: o.text, files: Array.isArray(o.files) ? o.files : [], runId: o.runId ?? '', cardId: o.cardId ?? '',
      harness: (o.harness ?? 'claude') as HarnessName, createdAt: o.createdAt ?? '', lastSeenAt: o.lastSeenAt ?? o.createdAt ?? '', seen: o.seen ?? 1,
    };
  } catch {
    return undefined;
  }
}

const STOPWORDS = new Set('the a an is are it in on of to so and or for with that this be as by at its into from can will when than then there here they them was were has have had do does did not no only just also any all'.split(' '));

/** Content words of a learning: lowercase, no stopwords, crude plural stripping. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (let w of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

/**
 * Same learning in other words? Overlap coefficient (shared words over the smaller word set) of at
 * least 0.65, both sides substantial. Calibrated on paraphrases workers actually produced: duplicates
 * scored 0.64-0.93, distinct facts 0.13-0.64. Files are deliberately not compared: a learning's files
 * are the card it was seen on, not its subject, and the same fact surfaces on different cards.
 */
export function similar(a: Pick<Learning, 'text'>, b: Pick<Learning, 'text'>): boolean {
  const wa = contentWords(a.text);
  const wb = contentWords(b.text);
  const smaller = Math.min(wa.size, wb.size);
  if (smaller < 4) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / smaller >= 0.65;
}

/** Merge a later sighting into the learning it belongs to. The first wording and origin win. */
function absorb(into: Learning, sighting: Learning): void {
  into.seen += sighting.seen;
  into.files = [...new Set([...into.files, ...sighting.files])];
  if (sighting.lastSeenAt > into.lastSeenAt) into.lastSeenAt = sighting.lastSeenAt;
  if (sighting.createdAt && sighting.createdAt < into.createdAt) into.createdAt = sighting.createdAt;
}

/** One entry per learning: sightings with the same id, then paraphrases, are folded into the first. */
export function fold(sightings: Learning[]): Learning[] {
  const out: Learning[] = [];
  const byId = new Map<string, Learning>();
  for (const s of sightings) {
    const match = byId.get(s.id) ?? out.find((l) => similar(l, s));
    if (match) {
      absorb(match, s);
      byId.set(s.id, match);
      continue;
    }
    const l = { ...s, files: [...s.files] };
    out.push(l);
    byId.set(l.id, l);
  }
  return out;
}

function score(l: Learning, opts: SelectOptions, files: Set<string>): number {
  let s = 0;
  if (opts.runId && l.runId === opts.runId) s += 4;
  if (files.size && l.files.some((f) => files.has(f))) s += 3;
  s += Math.min(l.seen, 5) * 0.5;
  return s;
}

// ---- store ----

export function openMemory(repoRoot: string, cfg: MemoryConfig): MemoryStore {
  const path = memoryPath(repoRoot, cfg);

  const readLog = (): Learning[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').map(parse).filter((l): l is Learning => Boolean(l));
  };
  const load = (): Learning[] => fold(readLog());

  const append = (lines: Learning[]): void => {
    if (!lines.length) return;
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };

  /** Rewrite the whole log (remove, compact). Atomic via rename. */
  const rewrite = (items: Learning[]): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, items.map((l) => JSON.stringify(l)).join('\n') + (items.length ? '\n' : ''));
    renameSync(tmp, path);
  };

  return {
    path,
    load,

    add(entries) {
      const known = load();
      const now = new Date().toISOString();
      const added: Learning[] = [];
      const lines: Learning[] = [];
      for (const e of entries) {
        const text = e.text.trim();
        if (!text) continue;
        const id = learningId(text);
        const files = [...new Set(e.files.map((f) => f.trim()).filter(Boolean))];
        const existing = known.find((l) => l.id === id) ?? known.find((l) => similar(l, { text }));
        if (existing) {
          // A sighting of a known learning: append it under the known id so `fold` needs no similarity pass to merge it.
          lines.push({ ...existing, files, lastSeenAt: now, seen: 1 });
          continue;
        }
        const l: Learning = { id, text, files, runId: e.runId, cardId: e.cardId, harness: e.harness, createdAt: now, lastSeenAt: now, seen: 1 };
        known.push(l);
        lines.push({ ...l });
        added.push(l);
      }
      append(lines);
      return added;
    },

    remove(id) {
      const items = load();
      const rest = items.filter((l) => l.id !== id && !l.id.startsWith(id));
      if (rest.length === items.length) return false;
      rewrite(rest);
      return true;
    },

    compact(root) {
      const log = readLog();
      const items = fold(log);
      const stale = (l: Learning) => l.files.length > 0 && l.files.every((f) => !existsSync(join(root, f)));
      const dropped = items.filter(stale);
      const kept = items.filter((l) => !stale(l));
      const merged = log.length - items.length;
      if (dropped.length || merged) rewrite(kept);
      return { kept: kept.length, dropped, merged };
    },

    select(opts = {}) {
      const maxItems = opts.maxItems ?? cfg.maxItems;
      const maxChars = opts.maxChars ?? cfg.maxChars;
      const files = new Set(opts.files ?? []);
      const root = opts.root;
      const ranked = load()
        .filter((l) => !root || l.files.length === 0 || l.files.some((f) => existsSync(join(root, f))))
        .map((l) => ({ l, s: score(l, opts, files) }))
        .sort((a, b) => b.s - a.s || b.l.lastSeenAt.localeCompare(a.l.lastSeenAt));
      const out: Learning[] = [];
      let chars = 0;
      for (const { l } of ranked) {
        if (out.length >= maxItems) break;
        if (chars + l.text.length > maxChars && out.length > 0) break;
        out.push(l);
        chars += l.text.length;
      }
      return out;
    },
  };
}

// ---- curation: what /memory and `dulger memory` do, as data ----
// The file is memoryPath(repoRoot, config.memory).

/** Every learning, folded, oldest first, and the file they live in. */
export function listMemory(repoRoot: string, config: Pick<Config, 'memory'>): { path: string; items: Learning[] } {
  const memory = openMemory(repoRoot, config.memory);
  return { path: memory.path, items: memory.load() };
}

/**
 * Record a learning by hand, with the repository paths the text mentions. Returns it, or undefined when
 * it is already known (as itself or in other words). Throws CliError for an empty text.
 */
export function addMemory(repoRoot: string, config: Pick<Config, 'memory' | 'harness'>, text: string): Learning | undefined {
  if (!text.trim()) throw new CliError('memory add needs a text');
  const [added] = openMemory(repoRoot, config.memory).add([{ text, files: extractPaths(text, repoRoot), runId: 'manual', cardId: 'manual', harness: config.harness }]);
  return added;
}

/**
 * Forget the learning `id`; every learning whose id starts with `id` goes with it. False when none
 * matched. Throws CliError for an empty id.
 */
export function removeMemory(repoRoot: string, config: Pick<Config, 'memory'>, id: string): boolean {
  if (!id) throw new CliError('memory rm needs an id');
  return openMemory(repoRoot, config.memory).remove(id);
}

/** Drop learnings about files that are all gone and fold repeated sightings; see MemoryStore.compact. */
export function compactMemory(repoRoot: string, config: Pick<Config, 'memory'>): { kept: number; dropped: Learning[]; merged: number } {
  return openMemory(repoRoot, config.memory).compact(repoRoot);
}

export function renderLearnings(items: Learning[]): string {
  return items
    .map((l) => {
      const extra = l.files.filter((f) => !l.text.includes(f)).slice(0, 3);
      return `- ${l.text}${extra.length ? ` (${extra.join(', ')}${l.files.length > 3 ? ', …' : ''})` : ''}`;
    })
    .join('\n');
}
