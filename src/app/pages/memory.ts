// The Memory tab: the notes ("learnings") agents keep about this repository and get in later prompts.
// A list of notes (glyph, text, age) with the counts in its border, the selected note's facts in a
// pane, and the curation actions as keys: add, remove, compact. `?` says what memory is, where it is
// kept and what each prompt takes of it. Replaces /memory list|add|rm|compact|path.
//
// The list state is the filter and selection engine (/ to filter, the movement keys); the kit's
// renderListTable draws its shown rows in columns, so both always agree on what is selected.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMemory, compactMemory, learningId, listMemory, memoryPath, removeMemory, similar, type Learning } from '../../context/memory.ts';
import { c } from '../../tui/theme.ts';
import { cell, chop, fit, plainText, width, wrap, wrapParagraphs } from '../../tui/text.ts';
import {
  badge, compose, createList, emptyState, hit, listCapturesText, listKey, listMouse, listShowsFilter, noticeModal, panel, renderListTable,
  renderScroll, scrollInfo, scrollKey, scrollLines, scrollMouse, selectId, selectedItem, setItems, setScrollLines, shownItems, splitCols,
  type HelpGroup, type Hint, type ListItem, type Rect, type Rendered, type Size, type TableColumn, type TableRow,
} from '../../tui/kit/index.ts';
import { localStamp, timeAgo } from '../look.ts';
import type { AppContext, Page, PageCommand } from '../types.ts';

type Sort = 'recent' | 'oldest';
const SORT_LABEL: Record<Sort, string> = { recent: 'Recent first', oldest: 'Oldest first' };

interface Note {
  l: Learning;
  /** Repo paths it mentions that no longer exist. */
  missing: Set<string>;
  /** Every file is gone: compaction drops it. */
  stale: boolean;
}

interface Loaded {
  path: string;
  location: 'user' | 'repo';
  maxItems: number;
  maxChars: number;
  notes: Note[];
  /** Log lines that compaction would fold into the notes they repeat. */
  repeats: number;
}

const EMPTY_RECT: Rect = { top: 0, left: 0, rows: 0, cols: 0 };

// A note is its glyph and text, then how long ago it was last seen; no header row.
const COLUMNS: TableColumn[] = [
  { title: 'Note', flex: 1, min: 20 },
  // As wide as the longest age ("now", "3h", "2026-10-01"), so the text gets the rest.
  { title: 'Seen', min: 3, align: 'right' },
];

export function createMemoryPage(ctx: AppContext): Page {
  const g = ctx.g;
  let data: Loaded | undefined;
  let loadError: string | undefined;
  /** Where the file that could not be read is, when that can be said. */
  let errorPath: string | undefined;
  let sort: Sort = 'recent';
  let focus: 'list' | 'detail' = 'list';
  const detail = scrollLines([]);
  let lastDropped: Learning[] | undefined;
  let rects = { list: EMPTY_RECT, detail: EMPTY_RECT, detailShown: false };

  const list = createList([], { filter: 'slash', empty: 'No notes.' });

  const notes = (): Note[] => data?.notes ?? [];
  const byId = (id: string | undefined): Note | undefined => (id === undefined ? undefined : notes().find((n) => n.l.id === id));
  const selected = (): Note | undefined => byId(selectedItem(list)?.id);

  const sorted = (all: Note[]): Note[] => {
    if (sort === 'oldest') return all.slice();
    // Ties keep file order; reversed so the latest sighting of equal stamps comes first.
    return all.slice().reverse().sort((a, b) => b.l.lastSeenAt.localeCompare(a.l.lastSeenAt));
  };

  const rebuild = () => {
    const before = selectedItem(list)?.id;
    setItems(list, sorted(notes()).map((n): ListItem => ({
      id: n.l.id,
      label: plainText(n.l.text),
      keywords: [...n.l.files, origin(n.l), n.l.id].join(' '),
    })));
    if (before !== undefined) selectId(list, before);
    detail.top = 0;
  };

  const reload = (select?: string) => {
    const config = ctx.config();
    try {
      const { path, items } = listMemory(ctx.repoRoot, config);
      data = {
        path, location: config.memory.location, maxItems: config.memory.maxItems, maxChars: config.memory.maxChars,
        notes: items.map((l) => noteOf(ctx.repoRoot, l)), repeats: repeatSightings(path, items.length),
      };
      loadError = undefined;
    } catch (e) {
      data = undefined;
      loadError = e instanceof Error ? e.message : String(e);
      try { errorPath = memoryPath(ctx.repoRoot, config.memory); } catch { errorPath = undefined; }
    }
    rebuild();
    if (select !== undefined) selectId(list, select);
  };

  // ---- actions ----

  const add = async () => {
    const text = await ctx.prompt({
      title: 'Add a note',
      placeholder: 'What should agents know?',
      multiline: true,
      validate: (v) => (v.trim() ? undefined : 'Empty note'),
    });
    if (text === undefined) return;
    try {
      const added = addMemory(ctx.repoRoot, ctx.config(), text);
      if (added) {
        reload(added.id);
        const files = added.files.length ? ` · ${count(added.files.length, 'file')} linked` : '';
        ctx.toast(`Note added${files}`, 'ok');
        return;
      }
      // Already known, as itself or in other words: the store counted another sighting of it.
      const id = learningId(text.trim());
      const known = notes().find((n) => n.l.id === id) ?? notes().find((n) => similar(n.l, { text: text.trim() }));
      reload(known?.l.id);
      const seen = known ? byId(known.l.id)?.l.seen : undefined;
      ctx.toast(`Already known${seen ? ` · seen ×${seen}` : ''}`, 'info');
    } catch (e) {
      ctx.toast(message(e), 'error');
    }
  };

  const remove = async () => {
    const n = selected();
    if (!n) { ctx.toast('No note selected', 'info'); return; }
    // removeMemory drops every id that starts with the one given; ids are full hashes, so only a
    // hand-edited file can have others that would go too — say so rather than surprise.
    const also = notes().filter((o) => o !== n && o.l.id.startsWith(n.l.id)).length;
    // The facts: the note itself, and the one consequence nobody could see from here.
    const yes = await ctx.confirm({
      title: 'Remove note',
      message: `“${fit(plainText(n.l.text), 180)}”${also ? `\n${ctx.g.warn} also removes ${count(also, 'other note')} with id ${plainText(n.l.id)}…` : ''}`,
      confirm: 'Remove',
      danger: true,
    });
    if (!yes) return;
    try {
      const gone = removeMemory(ctx.repoRoot, ctx.config(), n.l.id);
      reload();
      ctx.toast(gone ? 'Note removed' : 'Already gone', gone ? 'ok' : 'info');
    } catch (e) {
      ctx.toast(message(e), 'error');
    }
  };

  /** The memory file's path, whole. Where that is (repository or data folder) is in help. */
  const showPath = () => {
    if (!data) return Promise.resolve();
    return ctx.modal(noticeModal({ title: 'Memory file', message: '', detail: data.path })).then(() => undefined);
  };

  const showDropped = () => {
    if (!lastDropped?.length) { ctx.toast('Nothing dropped', 'info'); return Promise.resolve(); }
    return ctx.view({ title: `Dropped by compaction (${lastDropped.length})`, text: droppedText(lastDropped) });
  };

  const compact = async () => {
    const stale = notes().filter((n) => n.stale);
    const repeats = data?.repeats ?? 0;
    // The facts: what is merged, and each note that goes. What compaction is lives in help.
    const yes = await ctx.confirm({
      title: 'Compact memory',
      message: '',
      items: [
        { label: 'Merge', value: repeats ? count(repeats, 'repeated sighting') : 'nothing' },
        { label: 'Drop', value: stale.length ? count(stale.length, 'note') : 'nothing' },
        ...stale.map((n) => fit(plainText(n.l.text), 120)),
      ],
      // The one consequence that cannot be seen from here: a file only on an unmerged result branch is missing.
      note: stale.length ? `${ctx.g.warn} files only on unmerged dulger/… branches count as missing` : undefined,
      confirm: 'Compact',
      danger: stale.length > 0,
    });
    if (!yes) return;
    try {
      const r = compactMemory(ctx.repoRoot, ctx.config());
      lastDropped = r.dropped;
      reload();
      if (!r.dropped.length && !r.merged) { ctx.toast('Nothing to compact', 'info'); return; }
      ctx.toast(`Compacted · ${r.kept} kept, ${r.dropped.length} dropped, ${r.merged} merged`, 'ok');
      if (r.dropped.length) await showDropped();
    } catch (e) {
      ctx.toast(message(e), 'error');
    }
  };

  const read = () => {
    const n = selected();
    if (!n) return Promise.resolve();
    return ctx.view({ title: `Note ${n.l.id}`, text: detailPlain(n, ctx.now()) });
  };

  const toggleSort = () => {
    sort = sort === 'recent' ? 'oldest' : 'recent';
    rebuild();
    ctx.toast(SORT_LABEL[sort], 'info');
  };

  const startFilter = () => { focus = 'list'; list.filtering = true; };

  // ---- drawing ----

  /** The counts in the list's border: `4 notes · 345 chars`, marked past what a prompt takes. */
  const countsBadge = (): string => {
    if (!data) return '';
    const n = data.notes.length;
    const chars = data.notes.reduce((sum, x) => sum + x.l.text.length, 0);
    const over = n > data.maxItems || chars > data.maxChars;
    return badge(`${over ? `${g.warn} ` : ''}${count(n, 'note')} · ${num(chars)} chars`, over ? 'warn' : 'subtle');
  };

  const rowOf = (item: ListItem): TableRow => {
    const n = byId(item.id)!;
    const l = n.l;
    return {
      id: l.id,
      cells: [plainText(l.text), timeAgo(l.lastSeenAt, ctx.now()) || '–'],
      tones: [undefined, 'muted'],
      // The warning glyph marks a note none of whose files are in this checkout: compacting drops it.
      icons: [n.stale ? c.warn(g.warn) : c.muted(g.dot), undefined],
    };
  };

  const renderNotes = (inner: Size): string[] => renderListTable(list, COLUMNS, rowOf, inner, g, {
    focused: focus === 'list', header: false, empty: list.query ? 'No match' : 'No notes',
  });

  const renderDetail = (inner: Size): string[] => {
    const n = selected();
    if (!n) return emptyState(inner, { title: list.query ? 'No match' : 'No note selected' }, g);
    setScrollLines(detail, detailLines(n, inner.cols, ctx.now()), { keep: true });
    return renderScroll(detail, inner, g, { focused: focus === 'detail' });
  };

  /** The reader's own message, whole, and the file it was reading: all an error state shows. */
  const renderError = (size: Size): Rendered => {
    rects = { list: EMPTY_RECT, detail: EMPTY_RECT, detailShown: false };
    const why = `${g.warn} ${plainText(loadError ?? '') || 'unreadable'}`;
    const where = errorPath ? plainText(errorPath) : '';
    // As wide as the message and the path need, up to a readable measure.
    const w = Math.max(1, Math.min(size.cols - 4, 76, Math.max(20, width(why), width(where))));
    const lines = [
      ...wrapParagraphs(why, w).map((l) => c.bad(l)),
      ...(where ? chop(where, w).map((l) => c.muted(l)) : []),
    ];
    const rect = { top: 0, left: 0, rows: Math.min(size.rows, lines.length + 2), cols: Math.min(size.cols, w + 4) };
    return compose(size, [{ rect, block: panel(rect, { g, title: 'Memory', focused: true }, () => lines) }]);
  };

  const render = (size: Size): Rendered => {
    if (loadError !== undefined && !data) return renderError(size);
    if (!notes().length) {
      rects = { list: EMPTY_RECT, detail: EMPTY_RECT, detailShown: false };
      return { lines: emptyState(size, { title: 'No notes yet' }, g) };
    }
    const wide = size.cols >= 150 && size.rows >= 8;
    const showDetail = wide || size.rows >= 16;
    if (!showDetail && focus === 'detail') focus = 'list';
    // Each panel is as tall as its rows (the notes and the filter line; the note's facts), not the screen.
    const listWant = Math.max(1, shownItems(list).length) + (listShowsFilter(list, size.rows) ? 1 : 0) + 2;
    const n = selected();
    const detailWant = (cols: number) => (n ? detailLines(n, Math.max(1, cols - 4), ctx.now()).length : 1) + 2;
    let listRect: Rect;
    let detailRect = EMPTY_RECT;
    if (wide) {
      const [l, d] = splitCols({ top: 0, left: 0, ...size }, [{ flex: 3 }, { flex: 2, min: 40 }], 1) as [Rect, Rect];
      const rows = Math.min(size.rows, Math.max(listWant, detailWant(d.cols)));
      listRect = { ...l, rows };
      detailRect = { ...d, rows };
    } else if (showDetail) {
      const detailRows = Math.max(3, Math.min(14, Math.max(5, detailWant(size.cols)), size.rows - 3));
      const listRows = Math.min(listWant, size.rows - detailRows);
      listRect = { top: 0, left: 0, rows: listRows, cols: size.cols };
      detailRect = { top: listRows, left: 0, rows: detailRows, cols: size.cols };
    } else {
      listRect = { top: 0, left: 0, rows: Math.min(listWant, size.rows), cols: size.cols };
    }
    rects = { list: listRect, detail: detailRect, detailShown: showDetail };
    const parts: Array<{ rect: Rect; block: Rendered }> = [{ rect: listRect, block: panel(listRect, {
      g, title: 'Notes', focused: focus === 'list', badge: countsBadge(),
      // The order is named only when it is not the usual one.
      footer: sort === 'oldest' ? c.muted('oldest first') : undefined,
      scroll: () => ({ top: list.top, total: shownItems(list).length, visible: list.height }),
    }, renderNotes) }];
    if (showDetail) {
      parts.push({ rect: detailRect, block: panel(detailRect, { g, title: 'Note', focused: focus === 'detail', scroll: () => scrollInfo(detail) }, renderDetail) });
    }
    return compose(size, parts);
  };

  // ---- input ----

  const onKey: Page['onKey'] = (k) => {
    if (listCapturesText(list)) {
      const before = selectedItem(list)?.id;
      const used = listKey(list, k);
      if (selectedItem(list)?.id !== before) detail.top = 0;
      return used;
    }
    if ((k.name === 'tab' || k.name === 'shift-tab') && rects.detailShown && notes().length) { focus = focus === 'list' ? 'detail' : 'list'; return true; }
    if (focus === 'detail' && scrollKey(detail, k)) return true;
    if (k.name === 'char') {
      switch (k.ch) {
        case 'a': void add(); return true;
        case 'd': void remove(); return true;
        case 'c': void compact(); return true;
        case 's': toggleSort(); return true;
        case 'r': reload(selectedItem(list)?.id); ctx.toast('Reloaded', 'info'); return true;
        case 'v': void showDropped(); return true;
        case 'p': void showPath(); return true;
        case '/': startFilter(); return true;
      }
    }
    if (k.name === 'delete') { void remove(); return true; }
    if (k.name === 'enter') { void read(); return true; }
    const before = selectedItem(list)?.id;
    if (focus === 'list' && listKey(list, k)) {
      if (selectedItem(list)?.id !== before) detail.top = 0;
      return true;
    }
    return false;
  };

  const onMouse: NonNullable<Page['onMouse']> = (m) => {
    const inList = hit(m, rects.list);
    const inDetail = rects.detailShown ? hit(m, rects.detail) : undefined;
    if (inList) {
      if (m.kind === 'press') focus = 'list';
      // Panel content starts one row down and two columns in; the list knows its filter line and header.
      const before = list.index;
      const r = listMouse(list, { ...inList, row: inList.row - 1, col: inList.col - 2 });
      if (list.index !== before) detail.top = 0;
      if (r === 'activate') void read();
      return r !== false || m.kind === 'press';
    }
    if (inDetail) {
      if (m.kind === 'press') { focus = 'detail'; return true; }
      if (m.kind === 'wheel-up' || m.kind === 'wheel-down') return scrollMouse(detail, m);
    }
    return false;
  };

  const hints = (): Hint[] => {
    if (listCapturesText(list)) return [{ key: 'enter', label: 'done' }, { key: 'esc', label: 'clear' }];
    if (loadError !== undefined && !data) return [{ key: 'r', label: 'reload' }];
    if (!notes().length) return [{ key: 'a', label: 'add' }];
    if (focus === 'detail') return [{ key: '↑↓', label: 'scroll' }, { key: 'tab', label: 'notes' }, { key: 'd', label: 'remove' }, { key: 'a', label: 'add' }];
    return [
      { key: 'a', label: 'add' }, { key: 'd', label: 'remove' }, { key: 'c', label: 'compact' },
      // Without the detail pane, Enter is how a note is read whole.
      rects.detailShown ? { key: '/', label: 'filter' } : { key: g.enter, label: 'read' },
    ];
  };

  const noSelection = () => (selected() ? undefined : 'No note selected');
  const commands = (): PageCommand[] => [
    { id: 'add', title: 'Add a note', description: 'Record a convention or pitfall agents should know.', shortcut: 'a', run: add },
    { id: 'remove', title: 'Remove note', shortcut: 'd', disabled: noSelection(), run: remove },
    { id: 'compact', title: 'Compact memory', description: 'Merge repeated sightings and drop notes whose files are not in this checkout.', shortcut: 'c', run: compact },
    { id: 'read', title: 'Read note', shortcut: 'enter', disabled: noSelection(), run: read },
    { id: 'filter', title: 'Filter notes', shortcut: '/', run: startFilter },
    { id: 'sort', title: sort === 'recent' ? 'Sort oldest first' : 'Sort recent first', shortcut: 's', run: toggleSort },
    ...(lastDropped?.length ? [{ id: 'dropped', title: 'Dropped notes', description: 'What the last compaction dropped.', shortcut: 'v', run: showDropped }] : []),
    { id: 'reload', title: 'Reload memory', shortcut: 'r', run: () => { reload(selectedItem(list)?.id); ctx.toast('Reloaded', 'info'); } },
    { id: 'path', title: 'Memory file path', shortcut: 'p', run: showPath },
  ];

  /** What `?` says about the selected note: what compacting does with it. */
  const noteHelp = (): HelpGroup[] => {
    const n = selected();
    if (!n || listCapturesText(list)) return [];
    const files = n.l.files.length;
    const text = n.stale
      ? 'None of its files are in this checkout, so compacting drops it. Merge the run that made them first to keep it.'
      : !files ? 'It names no files, so compacting keeps it.'
        : n.missing.size ? `${n.missing.size} of its ${files} files are not in this checkout; compacting keeps it while one is.`
          : `Compacting keeps it while ${files === 1 ? 'its file is' : 'one of its files is'} in this checkout.`;
    return [{ title: fit(plainText(n.l.text), 60), keys: [], text }];
  };

  /** What `?` says about memory: what it is, what a prompt takes of it, where it is kept, what compacting does. */
  const about = (): string[] => {
    let m = data;
    if (!m) { try { const x = ctx.config().memory; m = { path: '', location: x.location, maxItems: x.maxItems, maxChars: x.maxChars, notes: [], repeats: 0 }; } catch { /* the error state says why */ } }
    return [
      'What agents learn about this repository (conventions, pitfalls, where things live), given to them in later prompts. Agents add notes during runs; a adds your own, linked to the files it names.',
      ...(m ? [
        `Each prompt gets the most relevant ${num(m.maxItems)} notes, up to ${num(m.maxChars)} characters. The border counts notes and characters, marked ${g.warn} when there are more, so some are left out.`,
        m.location === 'repo' ? 'Kept in this repository (.dulger), so it can be committed with it; p shows the path.' : 'Kept in your data folder, outside the repository; p shows the path.',
      ] : []),
      `Compacting merges repeated sightings and drops notes none of whose files are in this checkout (${g.warn} in the list), even when the files exist on a result branch that is not merged yet (dulger/…). Notes without files are kept.`,
    ];
  };

  const help = (): HelpGroup[] => [
    ...noteHelp(),
    { title: 'Notes', keys: [
      { key: '↑↓  j k', label: 'move' }, { key: 'pgup pgdn', label: 'page' }, { key: '/', label: 'filter (esc clears)' },
      { key: g.enter, label: 'read the whole note' }, { key: 'tab', label: 'notes / detail pane' }, { key: 's', label: 'recent first / oldest first' },
    ] },
    { title: 'Change memory', keys: [
      { key: 'a', label: 'add a note' }, { key: 'd  del', label: 'remove the selected note' },
      { key: 'c', label: 'compact: merge repeats, drop notes about files not in this checkout' }, { key: 'v', label: 'what the last compaction dropped' }, { key: 'p', label: 'the memory file\'s whole path' },
      { key: 'r', label: 'reload' },
    ] },
    { title: 'About', keys: [], text: about() },
  ];

  return {
    id: 'memory',
    title: 'Memory',
    activate() { reload(selectedItem(list)?.id); },
    render,
    onKey,
    onMouse,
    hints,
    commands,
    help,
    capturesText: () => listCapturesText(list),
    // No count of all notes on the tab: it asks nothing of the person. Notes compaction would drop do.
    badge: () => { const n = data ? notes().filter((x) => x.stale).length : 0; return n ? `${ctx.g.warn}${n}` : undefined; },
  };
}

// ---- data ----

function noteOf(root: string, l: Learning): Note {
  const missing = new Set(l.files.filter((f) => !safeExists(join(root, f))));
  return { l, missing, stale: l.files.length > 0 && missing.size === l.files.length };
}

function safeExists(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

/** How many log lines compaction would fold away: sightings beyond the first of each note. */
function repeatSightings(path: string, notes: number): number {
  try {
    if (!existsSync(path)) return 0;
    let lines = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line) as { id?: unknown; text?: unknown }; if (typeof o.id === 'string' && typeof o.text === 'string') lines++; } catch { /* compaction drops it too */ }
    }
    return Math.max(0, lines - notes);
  } catch {
    return 0;
  }
}

// ---- formatting ----

function message(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // The headless messages name the slash command they were written for.
  if (text === 'memory add needs a text') return 'Empty note';
  if (text === 'memory rm needs an id') return 'No note selected';
  return plainText(text) || 'Something went wrong.';
}

function count(n: number, noun: string): string {
  return `${num(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function origin(l: Learning): string {
  if (l.runId === 'manual' || (!l.runId && !l.cardId)) return 'added by hand';
  return [l.runId, l.cardId].filter(Boolean).join('/');
}

/** Where a note came from: `run r1 · card c1 · claude`, or `by hand · claude`. */
function fromText(l: Learning): string {
  const harness = plainText(l.harness ?? '');
  if (l.runId === 'manual') return ['by hand', harness].filter(Boolean).join(' · ');
  const parts = [l.runId && `run ${plainText(l.runId)}`, l.cardId && `card ${plainText(l.cardId)}`].filter(Boolean) as string[];
  return [...(parts.length ? parts : ['unknown']), harness].filter(Boolean).join(' · ');
}

/** A note's facts as label and value: how often and when it was seen, where it came from. */
function facts(l: Learning, now: number): Array<[string, string]> {
  // `3h · 2026-11-15 09:00`, the age as the list shows it; past a month it is the date, not said twice.
  const ago = timeAgo(l.lastSeenAt, now);
  const stamp = localStamp(l.lastSeenAt);
  const last = [stamp.startsWith(ago) ? '' : ago, stamp].filter(Boolean).join(' · ');
  return [
    ['Seen', `×${l.seen}`],
    ['Last', last || '–'],
    // First seen only when it is another minute than the last sighting.
    ...(l.createdAt && localStamp(l.createdAt) !== stamp ? [['First', localStamp(l.createdAt)] as [string, string]] : []),
    ['From', fromText(l)],
  ];
}

function detailLines(n: Note, w: number, now: number): string[] {
  const l = n.l;
  const labelW = 6;
  const valueW = Math.max(1, w - labelW - 1);
  const field = (label: string, values: string[]): string[] => values.map((v, i) => cell(c.muted(i ? '' : label), labelW) + ' ' + v);
  const files = l.files.length
    ? l.files.flatMap((f) => (n.missing.has(f) ? chop(`${f}  missing`, valueW).map((v) => c.warn(v)) : chop(f, valueW).map((v) => c.text(v))))
    : [c.muted('none')];
  const lines = [
    ...wrapParagraphs(l.text, Math.max(1, w)).map((x) => c.text(x)),
    '',
    ...facts(l, now).flatMap(([label, value]) => field(label, wrap(value, valueW).map((x) => c.subtle(x)))),
    ...field('Files', files),
    ...field('Id', [c.faint(l.id)]),
  ];
  return lines.map((x) => cell(x, w));
}

function detailPlain(n: Note, now: number): string {
  const l = n.l;
  const rows = [
    l.text, '',
    ...facts(l, now).map(([label, value]) => `${label.padEnd(6)} ${value}`),
    ...(l.files.length ? l.files.map((f, i) => `${i ? '       ' : 'Files  '}${f}${n.missing.has(f) ? '  missing' : ''}`) : ['Files  none']),
    `Id     ${l.id}`,
  ];
  return rows.join('\n');
}

/** The notes the last compaction dropped, each with its files and where it came from. */
function droppedText(dropped: Learning[]): string {
  return dropped.map((l) => `- ${l.text}\n  Files  ${l.files.join(', ')}\n  From   ${fromText(l)}`).join('\n\n') + '\n';
}
