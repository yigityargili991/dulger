// Learnings reported by workers, stored as JSONL in the project data dir (see paths.ts).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { STATE_DIR, type MemoryConfig } from '../config.ts';
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
  compact(root: string): { kept: number; dropped: Learning[] };
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

  const load = (): Learning[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').map(parse).filter((l): l is Learning => Boolean(l));
  };

  const write = (items: Learning[]): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, items.map((l) => JSON.stringify(l)).join('\n') + (items.length ? '\n' : ''));
    renameSync(tmp, path);
  };

  return {
    path,
    load,

    add(entries) {
      const items = load();
      const byId = new Map(items.map((l) => [l.id, l]));
      const now = new Date().toISOString();
      const added: Learning[] = [];
      for (const e of entries) {
        const text = e.text.trim();
        if (!text) continue;
        const id = learningId(text);
        const files = [...new Set(e.files.map((f) => f.trim()).filter(Boolean))];
        const existing = byId.get(id);
        if (existing) {
          existing.seen++;
          existing.lastSeenAt = now;
          existing.files = [...new Set([...existing.files, ...files])];
          continue;
        }
        const l: Learning = { id, text, files, runId: e.runId, cardId: e.cardId, harness: e.harness, createdAt: now, lastSeenAt: now, seen: 1 };
        byId.set(id, l);
        items.push(l);
        added.push(l);
      }
      if (entries.length) write(items);
      return added;
    },

    remove(id) {
      const items = load();
      const rest = items.filter((l) => l.id !== id && !l.id.startsWith(id));
      if (rest.length === items.length) return false;
      write(rest);
      return true;
    },

    compact(root) {
      const items = load();
      const stale = (l: Learning) => l.files.length > 0 && l.files.every((f) => !existsSync(join(root, f)));
      const dropped = items.filter(stale);
      const kept = items.filter((l) => !stale(l));
      if (dropped.length) write(kept);
      return { kept: kept.length, dropped };
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

export function renderLearnings(items: Learning[]): string {
  return items
    .map((l) => {
      const extra = l.files.filter((f) => !l.text.includes(f)).slice(0, 3);
      return `- ${l.text}${extra.length ? ` (${extra.join(', ')}${l.files.length > 3 ? ', …' : ''})` : ''}`;
    })
    .join('\n');
}
