// A run's result, pushed over a tab after a run and from Runs: a section bar, then the report, the
// changed files with their diffs, what verification established, or the merge (From, Into, its state,
// one button). It stays open until dismissed; the merge asks first naming source and destination, says
// what blocks it instead of failing, and a failure (a conflict included) is shown here in full. Going
// back leaves the result on its branch. `?` says what each section means.
import { existsSync } from 'node:fs';
import * as store from '../../board/store.ts';
import { changedFiles, fileDiff } from '../../runs.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { cell, plainText, width } from '../../tui/text.ts';
import {
  button, compose, createList, createScroll, emptyState, hit, listCapturesText, listKey, listMouse, listScroll, panel, renderList, renderScroll,
  renderTabs, scrollInfo, scrollKey, scrollLines, scrollMouse, scrollPosition, selectedItem, setItems, setScrollLines, setScrollText, shownItems, splitRows,
  tabAt, toggleWrap, type HelpGroup, type Hint, type Rect, type Rendered, type ScrollState, type Size, type TabBar,
} from '../../tui/kit/index.ts';
import type { Key, Mouse } from '../../tui/screen.ts';
import type { Board, VerificationResult } from '../../types.ts';
import type { AppContext, Page, PageCommand } from '../types.ts';
import { launchResume as defaultResume, launchRetry as defaultRetry } from '../run.ts';
import { blockerReason, cardChecks, diffSummary, duration, mergeOff, numstat, reportText, resumeFixes, runActions, runDetail, type RunDetail } from './runs.data.ts';
import { abortMergeFlow, mergeFlow, retryFlow, type MergeOutcome } from './runs.flows.ts';
import { errorState, factLines } from './runs.render.ts';
import { cardLook } from '../look.ts';

export type ReviewSection = 'summary' | 'files' | 'verify' | 'merge';
export interface ReviewOptions {
  /** The section shown first (default the summary). */
  section?: ReviewSection;
  /** Ask to merge as soon as the page opens (Runs' merge action). */
  merge?: boolean;
}
export interface ReviewDeps { launchResume: typeof defaultResume; launchRetry: typeof defaultRetry }

const SECTIONS: Array<{ id: ReviewSection; title: string; key: string }> = [
  { id: 'summary', title: 'Summary', key: 's' },
  { id: 'files', title: 'Files', key: 'f' },
  { id: 'verify', title: 'Verification', key: 'v' },
  { id: 'merge', title: 'Merge', key: 'm' },
];
const EMPTY: Rect = { top: 0, left: 0, rows: 0, cols: 0 };

/** A run's result: report, changed files with diffs, verification, and the merge. Pushed over a tab. */
export function createReviewPage(ctx: AppContext, runId: string, o: ReviewOptions = {}, deps: Partial<ReviewDeps> = {}): Page {
  // Read again at every render: the Icons setting applies at once.
  let g = ctx.g;
  const root = ctx.repoRoot;
  const launchResume = deps.launchResume ?? defaultResume;
  const launchRetry = deps.launchRetry ?? defaultRetry;
  let section: ReviewSection = o.section ?? 'summary';
  let startMerge = Boolean(o.merge);

  let detail: RunDetail | undefined;
  let loadError: string | undefined;
  let files: string[] = [];
  let stats = new Map<string, string>();
  /** The list width the file labels were last fitted to. */
  let labelsFor = -1;
  let filesError: string | undefined;
  const fileList = createList([], { filter: 'slash', empty: 'No changed files.' });
  const diffs = new Map<string, string>();
  const diff = createScroll('', { diff: true, wrap: false });
  let diffFor: string | undefined;
  let pane: 'files' | 'diff' = 'files';
  // The report, verification and merge texts keep their own styles: kit scroll views over styled lines.
  const summary = scrollLines([]);
  let summaryKey = '';
  const verify = scrollLines([]);
  const mergeDoc = scrollLines([]);
  let outcome: MergeOutcome | undefined;
  let conflicts: string[] | undefined;
  let bar: TabBar = { line: '', spans: [] };
  let rects = { bar: EMPTY, body: EMPTY, list: EMPTY, diff: EMPTY, button: EMPTY };
  let cols = 100;
  /** The width the merge rows were last laid out for. */
  let mergeWidth = -1;

  const message = (e: unknown) => plainText(e instanceof Error ? e.message : String(e));
  /** Work started from a key or a click: a failure becomes an error toast, never an unhandled rejection. */
  const guard = (p: Promise<unknown>) => { p.catch((e) => ctx.toast(message(e) || 'Error', 'error')); };

  function load(): void {
    try {
      const board = store.loadBoard(root, runId);
      detail = runDetail(root, board, ctx.config);
      loadError = undefined;
    } catch (e) {
      detail = undefined;
      loadError = existsSync(store.boardPath(root, runId)) ? message(e) : `No run ${plainText(runId)}`;
      return;
    }
    const d = detail;
    files = [];
    filesError = undefined;
    if (!d.branchExists) filesError = 'Branch gone';
    else {
      try { files = changedFiles(root, d.board); } catch (e) { filesError = message(e); }
    }
    stats = files.length ? numstat(root, d.board) : new Map<string, string>();
    labelsFor = -1;
    setItems(fileList, files.map((f) => ({ id: f, label: f, meta: stats.get(f), keywords: f })));
    diffs.clear();
    diffFor = undefined;
    summaryKey = '';
    // Only a merge that is this run's own (its MERGE_HEAD is the run branch tip) can be aborted here; a
    // merge the person started is left alone and never offered an abort.
    conflicts = d.mergeHalt?.ours ? d.mergeHalt.conflicts : undefined;
    setScrollLines(verify, verificationLines(d, g), { keep: true });
    mergeWidth = -1;
    setScrollLines(mergeDoc, mergeLines(), { keep: true });
  }

  const actions = () => (detail ? runActions(detail) : []);
  const action = (id: string) => actions().find((a) => a.id === id);

  // ---- the merge section ----

  /** From, Into and the state as rows; then what stops the merge or what it left, as short state lines. */
  function mergeLines(w = 80): string[] {
    const d = detail;
    if (!d) return [];
    const b = d.board;
    const branch = plainText(b.runBranch);
    const into = plainText(d.into);
    const stat = d.branchExists ? diffSummary(root, b) : undefined;
    const off = mergeOff(d);
    const foreign = Boolean(d.mergeHalt && !d.mergeHalt.ours);
    const left = b.cards.filter((x) => x.status !== 'done' && x.status !== 'replaced');
    // Blocked says by what: each blocker as its state, or the one reason that keeps the merge off.
    const why = !off ? '' : !foreign && d.blockers.length && d.branchExists && !d.noChanges && !d.holder
      ? [...new Set(d.blockers.map((bl) => blockerReason(bl, d)))].join(', ') : plainText(off);
    const state = d.merged ? { glyph: c.ok(g.check), paint: c.ok, value: `merged → ${into}` }
      : off ? { glyph: c.bad(g.cross), paint: c.bad, value: why }
        : { glyph: c.ok(g.check), paint: c.ok, value: 'ready' };
    const out = factLines([
      { label: 'From', value: d.branchExists ? `${branch}${stat ? ` · ${stat}` : ' · no changes'}` : `${branch} · gone`, paint: d.branchExists ? c.text : c.bad },
      { label: 'Into', value: into },
      { label: 'State', ...state },
      // Only what landed is merged.
      ...(left.length && !d.merged ? [{ label: 'Not landed', value: left.map((x) => `${plainText(x.id)} ${x.status.replace('_', ' ')}`).join(', '), paint: c.warn }] : []),
    ], w);
    // A stopped merge and a failure: the files and git's own words.
    const lines: string[] = [];
    if (conflicts) {
      lines.push(`${c.warn(g.warn)} ${c.text(conflicts.length ? `conflicts: ${conflicts.length}` : 'merge stopped')}`);
      for (const f of conflicts) lines.push(c.warn(`  ${plainText(f)}`));
    }
    if (outcome?.kind === 'failed') {
      lines.push(c.bad(`${g.cross} merge failed`));
      for (const l of outcome.text.split('\n')) lines.push(c.bad(`  ${plainText(l)}`));
    }
    return lines.length ? [...out, '', ...lines] : out;
  }

  async function doMerge(): Promise<void> {
    section = 'merge';
    load();
    if (!detail) { ctx.toast(loadError ?? 'Board unreadable', 'error'); return; }
    const r = await mergeFlow(ctx, detail);
    if (r.kind !== 'none') outcome = r;
    load();
    ctx.redraw();
  }

  async function doAbort(): Promise<void> {
    if (await abortMergeFlow(ctx)) outcome = undefined;
    load();
    ctx.redraw();
  }

  async function run(id: 'resume' | 'retry'): Promise<void> {
    load();
    const a = action(id);
    if (!detail || !a) { ctx.toast(loadError ?? 'Board unreadable', 'error'); return; }
    if (!a.enabled) { ctx.toast(`${a.label}: ${a.note}`, 'warn'); return; }
    if (id === 'retry') await retryFlow(ctx, detail, undefined, launchRetry);
    // The launcher asks first, with the choice of settings when the run's differ from the session's.
    else await launchResume(ctx, runId);
    load();
  }

  // ---- drawing ----

  function summaryLines(d: RunDetail, w: number): string[] {
    return styleReport(reportText(root, d.board, w, d.merged ? d.into : undefined), g);
  }

  const docPanel = (r: Rect, title: string, doc: ScrollState, badge?: string) => panel(r, {
    g, title, focused: true, badge, footer: () => c.muted(scrollPosition(doc)), scroll: () => scrollInfo(doc),
  }, (inner) => renderScroll(doc, inner, g, { focused: true }));

  /** A document's box: the full width, as tall as its rows at that width (wrapped or not), up to the body. */
  const docRect = (body: Rect, doc: ScrollState): Rect => {
    doc.width = Math.max(1, body.cols - 4);
    return { ...body, rows: Math.min(body.rows, scrollInfo(doc).total + 2) };
  };

  function renderSummary(body: Rect): { rect: Rect; block: Rendered } {
    const d = detail!;
    const w = Math.max(10, body.cols - 4);
    const key = `${w}:${d.merged}`;
    if (key !== summaryKey) { summaryKey = key; setScrollLines(summary, summaryLines(d, w), { keep: true }); }
    const r = docRect(body, summary);
    return { rect: r, block: docPanel(r, 'Report', summary) };
  }

  function loadDiff(file: string | undefined): void {
    diffFor = file;
    if (!file || !detail) { setScrollText(diff, ''); return; }
    let text = diffs.get(file);
    if (text === undefined) {
      try { text = fileDiff(root, detail.board, file) || 'No text diff'; }
      catch (e) { text = message(e); }
      diffs.set(file, text);
    }
    setScrollText(diff, text);
    diff.top = 0;
    diff.left = 0;
  }

  function renderFiles(r: Rect): Array<{ rect: Rect; block: string[] | Rendered }> {
    if (filesError || !files.length) {
      const title = filesError ?? 'No changes';
      const box: Rect = { ...r, rows: Math.min(r.rows, 3), cols: Math.min(r.cols, Math.max(30, width(title) + 8)) };
      return [{ rect: box, block: panel(box, { g, title: 'Files' }, (inner) => emptyState(inner, { title }, g)) }];
    }
    const file = selectedItem(fileList)?.id;
    if (file !== diffFor) loadDiff(file);
    const wide = r.cols >= 80;
    // The list as wide as its longest path and its counts (28 to 56 columns) and as tall as its rows; the
    // diff, a document, takes the rest.
    const listW = Math.max(28, Math.min(56, width(g.pointer) + 1 + Math.max(0, ...files.map((f) => width(f) + (stats.get(f) ? width(stats.get(f)!) + 1 : 0))) + 4));
    const listH = Math.min(r.rows, Math.max(1, shownItems(fileList).length) + 2 + (fileList.filtering || fileList.query ? 1 : 0));
    const [l, dr] = wide
      ? [{ ...r, rows: listH, cols: listW }, { ...r, left: r.left + listW + 1, cols: r.cols - listW - 1 }]
      : splitRows(r, [Math.max(3, Math.min(fileList.items.length + 2, Math.floor(r.rows * 0.4), 10)), { flex: 1 }]);
    rects.list = l!;
    rects.diff = dr!;
    fitLabels(Math.max(1, l!.cols - 4));
    const binary = /^Binary files /m.test(diffs.get(file ?? '') ?? '');
    return [
      { rect: l!, block: panel(l!, { g, title: 'Files', focused: pane === 'files', badge: c.muted(String(files.length)), scroll: () => listScroll(fileList) },
        (inner) => renderList(fileList, inner, g, { focused: pane === 'files', keepMeta: true })) },
      { rect: dr!, block: panel(dr!, {
        g, title: file ?? 'Diff', focused: pane === 'diff', badge: binary ? c.muted('binary') : diff.wrap ? c.muted('wrap') : undefined,
        footer: () => c.muted(scrollPosition(diff)), scroll: () => scrollInfo(diff),
      }, (inner) => renderScroll(diff, inner, g, { focused: pane === 'diff' })) },
    ];
  }

  /**
   * File names that do not fit keep their end: the file name and the folders right above it
   * ("…/cards/c1/test1.txt"), so files in long paths stay apart. The full path stays the filter's word.
   */
  function fitLabels(cols: number): void {
    if (cols === labelsFor) return;
    labelsFor = cols;
    const pointer = width(g.pointer) + 1;
    setItems(fileList, files.map((f) => {
      const meta = stats.get(f);
      const room = Math.max(4, cols - pointer - (meta ? width(meta) + 1 : 0));
      return { id: f, label: tailFit(f, room), meta, keywords: f };
    }));
  }

  /** The merge box: as wide as its rows (at least 44 columns) and as tall as they are with the button. */
  function mergeRect(body: Rect): Rect {
    const d = detail!;
    const w = Math.min(body.cols, Math.max(44, ...mergeLines(200).map((l) => width(l))) + 4);
    const btnRows = d.merged ? 0 : 2;
    return { ...body, cols: w, rows: Math.min(body.rows, mergeLines(Math.max(1, w - 4)).length + btnRows + 2) };
  }

  function renderMerge(r: Rect): Rendered {
    const d = detail!;
    const off = mergeOff(d);
    return panel(r, { g, title: d.merged ? 'Merged' : 'Merge', focused: true, scroll: () => scrollInfo(mergeDoc) }, (inner) => {
      if (inner.cols !== mergeWidth) { mergeWidth = inner.cols; setScrollLines(mergeDoc, mergeLines(inner.cols), { keep: true }); }
      // The button follows the rows, or sits at the bottom while they scroll; dimmed while it is off.
      const btnRows = d.merged || inner.rows < 3 ? 0 : 2;
      mergeDoc.width = inner.cols;
      const textRows = Math.min(scrollInfo(mergeDoc).total, inner.rows - btnRows);
      const body = renderScroll(mergeDoc, { rows: textRows, cols: inner.cols }, g, { focused: true });
      rects.button = EMPTY;
      if (!btnRows) return body;
      const btn = off ? c.faint('  Merge  ') : button('Merge', true);
      if (!off) rects.button = { top: r.top + 1 + textRows + 1, left: r.left + 2, rows: 1, cols: width(btn) };
      return [...body, '', cell(btn, inner.cols)];
    });
  }

  function render(size: Size): Rendered {
    g = ctx.g;
    cols = size.cols;
    rects = { bar: EMPTY, body: EMPTY, list: EMPTY, diff: EMPTY, button: EMPTY };
    if (!detail) {
      return { lines: errorState(size, 'Cannot review', loadError) };
    }
    const area: Rect = { top: 0, left: 0, ...size };
    const showBar = size.rows >= 4;
    const [barRect, body] = showBar ? splitRows(area, [1, { flex: 1 }]) : [EMPTY, area];
    rects.bar = barRect!;
    rects.body = body!;
    const parts: Array<{ rect: Rect; block: string[] | Rendered }> = [];
    if (showBar) parts.push({ rect: barRect!, block: [sectionBar(size.cols)] });
    if (section === 'summary') parts.push(renderSummary(body!));
    if (section === 'files') parts.push(...renderFiles(body!));
    if (section === 'verify') { const r = docRect(body!, verify); parts.push({ rect: r, block: docPanel(r, 'Verification', verify, verifyBadge(detail)) }); }
    if (section === 'merge') { const r = mergeRect(body!); parts.push({ rect: r, block: renderMerge(r) }); }
    return compose(size, parts);
  }

  function sectionBar(w: number): string {
    const d = detail!;
    const items = SECTIONS.map((s) => ({
      id: s.id, title: s.id === 'merge' && d.merged ? 'Merged' : s.title,
      badge: s.id === 'files' ? (filesError ? '-' : String(files.length)) : s.id === 'verify' ? verifyBadge(d) : s.id === 'merge' ? (d.merged ? undefined : mergeOff(d) ? 'blocked' : 'ready') : undefined,
    }));
    bar = renderTabs(items, SECTIONS.findIndex((s) => s.id === section), w, { numbers: false });
    return bar.line;
  }

  // ---- keys and mouse ----

  function sectionKey(k: Key): boolean {
    if (k.name !== 'char') return false;
    const s = SECTIONS.find((x) => x.key === k.ch);
    if (!s) return false;
    if (s.id === 'merge' && section === 'merge') guard(doMerge());
    else section = s.id;
    return true;
  }

  function fileKey(k: Key): boolean {
    if (pane === 'files' && listCapturesText(fileList)) return listKey(fileList, k);
    if (k.name === 'tab' || k.name === 'shift-tab') { pane = pane === 'files' ? 'diff' : 'files'; return true; }
    if (pane === 'diff' && k.name === 'escape') { pane = 'files'; return true; }
    if (k.name === 'enter') { openDiff(); return true; }
    if (k.name === 'char' && k.ch === 'w') { toggleWrap(diff); return true; }
    if (pane === 'files') {
      // The list keeps the arrows; paging and panning always move the diff.
      if (['pageup', 'pagedown', 'left', 'right'].includes(k.name) || (k.name === 'char' && [' ', 'b', 'h', 'l'].includes(k.ch))) return scrollKey(diff, k);
      return listKey(fileList, k);
    }
    return scrollKey(diff, k);
  }

  function openDiff(): void {
    const file = selectedItem(fileList)?.id;
    if (!file) return;
    if (file !== diffFor) loadDiff(file);
    guard(ctx.view({ title: file, text: diffs.get(file) ?? '', diff: true }));
  }

  function onKey(k: Key): boolean {
    if (!detail) return false;
    if (section === 'files' && pane === 'files' && listCapturesText(fileList)) return fileKey(k);
    if (sectionKey(k)) return true;
    if (k.name === 'char') {
      if (k.ch === 'r') { guard(run('resume')); return true; }
      if (k.ch === 't') { guard(run('retry')); return true; }
      if (k.ch === 'a' && conflicts) { guard(doAbort()); return true; }
    }
    switch (section) {
      case 'files': return fileKey(k);
      case 'merge':
        if (k.name === 'enter') { guard(doMerge()); return true; }
        return scrollKey(mergeDoc, k);
      case 'summary':
        if (k.name === 'char' && k.ch === 'w') { toggleWrap(summary); return true; }
        return scrollKey(summary, k);
      case 'verify':
        if (k.name === 'char' && k.ch === 'w') { toggleWrap(verify); return true; }
        return scrollKey(verify, k);
    }
  }

  const inside = (m: Mouse) => ({ ...m, row: m.row - 1, col: m.col - 2 });

  function onMouse(m: Mouse): boolean {
    if (!detail) return false;
    const onBar = hit(m, rects.bar);
    if (onBar) {
      const i = m.kind === 'press' ? tabAt(bar, onBar.col) : undefined;
      if (i !== undefined) section = SECTIONS[i]!.id;
      return true;
    }
    if (section === 'files') {
      const inList = hit(m, rects.list);
      if (inList) { if (m.kind === 'press') pane = 'files'; if (listMouse(fileList, inside(inList)) === 'activate') openDiff(); return true; }
      const inDiff = hit(m, rects.diff);
      if (inDiff) { if (m.kind === 'press') pane = 'diff'; scrollMouse(diff, m); return true; }
      return false;
    }
    if (section === 'merge' && m.kind === 'press' && hit(m, rects.button)) { guard(doMerge()); return true; }
    const doc = section === 'summary' ? summary : section === 'verify' ? verify : mergeDoc;
    return scrollMouse(doc, m);
  }

  // ---- hints, palette, help ----

  function hints(): Hint[] {
    if (!detail) return [];
    const can = !mergeOff(detail) && !detail.merged;
    // What the result needs next, first: the merge, or the resume that unblocks it.
    const next: Hint[] = can ? [{ key: section === 'merge' ? g.enter : 'm', label: 'merge' }]
      : !detail.merged && resumeFixes(detail) && action('resume')?.enabled ? [{ key: 'r', label: 'resume' }] : [];
    switch (section) {
      case 'files':
        if (pane === 'files' && listCapturesText(fileList)) return [{ key: g.enter, label: 'done' }, { key: 'esc', label: 'clear' }];
        if (!files.length) return [...next, { key: 's', label: 'summary' }];
        return pane === 'files'
          ? [{ key: g.enter, label: 'full' }, { key: 'tab', label: 'diff' }, { key: 'w', label: 'wrap' }, { key: '/', label: 'filter' }]
          : [{ key: g.enter, label: 'full' }, { key: 'tab', label: 'files' }, { key: 'w', label: 'wrap' }, { key: '↑↓', label: 'scroll' }];
      case 'merge': {
        const abort = conflicts ? [{ key: 'a', label: 'abort' }] : [];
        return [...next, ...abort, { key: 's', label: 'summary' }, { key: 'f', label: 'files' }].slice(0, 4);
      }
      default:
        return [...next, { key: 'f', label: 'files' }, { key: section === 'verify' ? 's' : 'v', label: section === 'verify' ? 'summary' : 'verify' }, { key: '↑↓', label: 'scroll' }].slice(0, 4);
    }
  }

  function commands(): PageCommand[] {
    const d = detail;
    // The page's own commands carry no prefix in the palette (the shell's rule), so none is set here.
    const GROUP: string | undefined = undefined;
    const own: PageCommand[] = SECTIONS.map((s) => ({ id: `show-${s.id}`, group: GROUP, title: `Show ${s.title.toLowerCase()}`, shortcut: s.key, run: () => { section = s.id; } }));
    if (!d) return own;
    const off = mergeOff(d);
    const noFiles = files.length ? undefined : 'No changes';
    const pick = (id: 'resume' | 'retry', key: string): PageCommand => {
      const a = action(id)!;
      return { id, group: GROUP, title: a.label, shortcut: key, disabled: a.enabled ? undefined : `${a.label}: ${a.note}`, run: () => run(id) };
    };
    return [
      { id: 'merge', group: GROUP, title: `Merge ${plainText(d.board.runBranch)} → ${plainText(d.into)}`, shortcut: section === 'merge' ? g.enter : 'm',
        disabled: off ? (d.merged ? `Merged → ${plainText(d.into)}` : `Merge: ${off}`) : undefined, run: doMerge },
      pick('resume', 'r'), pick('retry', 't'),
      ...(conflicts ? [{ id: 'abort', group: GROUP, title: 'Abort the stopped merge', shortcut: 'a', run: doAbort }] : []),
      ...own,
      { id: 'diff', group: GROUP, title: 'Open the diff full screen', shortcut: g.enter, disabled: noFiles, run: () => { section = 'files'; openDiff(); } },
      { id: 'filter', group: GROUP, title: 'Filter changed files', shortcut: '/', disabled: noFiles, run: () => { section = 'files'; pane = 'files'; fileList.filtering = true; } },
      { id: 'wrap', group: GROUP, title: 'Toggle line wrap', shortcut: 'w', run: () => toggleWrap(section === 'files' ? diff : section === 'verify' ? verify : section === 'merge' ? mergeDoc : summary) },
      { id: 'reload', group: GROUP, title: 'Reload the run', run: load },
    ];
  }

  /** What the section on screen is, for `?`'s first group. */
  function sectionGroup(): HelpGroup | undefined {
    const d = detail;
    if (!d) return loadError ? { title: 'Cannot review', keys: [], text: loadError } : undefined;
    const into = plainText(d.into);
    const branch = plainText(d.board.runBranch);
    switch (section) {
      case 'summary': return { title: 'Summary', keys: [], text: 'The run\'s report: what landed, what did not and why, the documentation, the final verification, the changes.' };
      case 'files': return { title: 'Files', keys: [], text: `What ${branch} changes against the run's base, each file with its line counts, and its diff.` };
      case 'verify': return { title: 'Verification', keys: [], text: 'The final verification runs the verify commands on the result once the last card has landed. None: no verify commands were configured, so nothing checked the result; cards only: only the cards\' own checks ran. Stale: the branch changed after it ran; resuming verifies it again.' };
      case 'merge': return { title: d.merged ? 'Merged' : 'Merge', keys: [], text: [
        `Merges ${branch} into ${into}, the branch checked out here, after a confirmation; ${branch} is kept. Only what landed comes along.`,
        'What blocks it is listed under State: a result not yet verified, a failed or stale verification or unfinished docs (resume the run, r, to finish it), a dirty working tree (commit first), a merge in progress.',
        `A merge stopped by conflicts: resolve them in your editor and commit, or abort it (a) to put ${into} back as it was. A merge you started yourself is left alone: finish or abort it yourself.`,
        `To leave the result on its branch, go back (esc): it stays on ${branch}, to merge later from Runs or here.`,
      ] };
    }
  }

  function help(): HelpGroup[] {
    return [
      ...[sectionGroup()].filter((x): x is HelpGroup => Boolean(x)),
      { title: 'Sections', keys: SECTIONS.map((s) => ({ key: s.key, label: s.id === 'merge' ? 'merge (press again to merge)' : s.title.toLowerCase() })) },
      { title: 'Reading', keys: [{ key: '↑↓  pgup pgdn', label: 'scroll' }, { key: '←→', label: 'pan (no wrap)' }, { key: 'w', label: 'wrap lines' }] },
      { title: 'Files', keys: [
        { key: '↑↓', label: 'choose a file' }, { key: 'pgup pgdn', label: 'scroll its diff' }, { key: 'tab', label: 'move between files and diff' },
        { key: g.enter, label: 'diff full screen' }, { key: '/', label: 'filter files' },
      ] },
      { title: 'The result', keys: [
        { key: 'm  ' + g.enter, label: 'merge, after a confirmation' }, { key: 'r', label: 'resume the run (asks first)' },
        { key: 't', label: 'retry a failed card' }, { key: 'a', label: 'abort a stopped merge' }, { key: 'esc', label: 'back; the result stays put' },
      ] },
    ];
  }

  return {
    id: `review:${runId}`,
    title: `Review ${runId}`,
    activate() {
      load();
      if (startMerge) { startMerge = false; guard(doMerge()); }
    },
    render,
    onKey,
    onMouse,
    hints,
    commands,
    help,
    capturesText: () => section === 'files' && pane === 'files' && listCapturesText(fileList),
  };
}

// ---- documents ----

/** A path in at most `w` cells keeping its end, from a folder boundary when that leaves the file name whole. */
export function tailFit(path: string, w: number): string {
  if (width(path) <= w) return path;
  if (w <= 1) return '…'.slice(0, Math.max(0, w));
  const chars = [...path];
  let tail = '';
  for (let i = chars.length - 1; i >= 0 && width(chars[i]! + tail) <= w - 1; i--) tail = chars[i]! + tail;
  const slash = tail.indexOf('/');
  if (slash >= 0 && slash < tail.length - 1) tail = tail.slice(slash);
  return '…' + tail;
}

/** The report's lines, sanitized, with the headings and pass/fail lines coloured again. */
function styleReport(text: string, g: Glyphs): string[] {
  let heading = '';
  return text.split('\n').map((raw, i) => {
    const line = plainText(raw);
    if (i === 0) { const m = line.match(/^(Run \S+)(.*)$/); return m ? c.text.bold(m[1]!) + c.muted(m[2]!) : c.text.bold(line); }
    if (['Landed', 'Not landed', 'Documentation', 'Final verification', 'Changes'].includes(line)) {
      heading = line;
      return line === 'Not landed' ? c.bad.bold(line) : c.accent.bold(line);
    }
    if (/^\s+PASS /.test(line)) return c.ok(line.replace('PASS', g.check));
    if (/^\s+FAIL /.test(line)) return c.bad(line.replace('FAIL', g.cross));
    if (/^\s+note: /.test(line)) return c.warn(line);
    if (/^\s+verified: nothing/.test(line)) return c.warn(line);
    if (/^Goal: /.test(line)) return c.muted('Goal: ') + c.text(line.slice(6));
    if (heading === 'Changes') return c.muted(line);
    if (heading === 'Not landed' && /^ {2}\S/.test(line)) return c.text(line);
    return c.text(line);
  });
}

function verifyBadge(d: RunDetail): string | undefined {
  switch (d.final) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'stale': return 'stale';
    case 'none-configured': {
      // Nothing to check on the final result: say what the cards' own checks did instead of "none".
      const cards = cardChecks(d.board);
      return cards === 'none' ? 'none' : cards === 'failed' ? 'card failed' : cards === 'passed' ? 'cards passed' : 'cards only';
    }
    default: return undefined;
  }
}

function resultLines(r: VerificationResult, g: Glyphs): string[] {
  const mark = r.ok ? c.ok(g.check) : c.bad(g.cross);
  const cmd = r.command.replace(/\r\n?/g, '\n').split('\n').map((l) => plainText(l));
  const meta = c.muted(`exit ${r.exitCode} · ${duration(r.durationMs)}`);
  const out = cmd.map((l, i) => (i ? `      ${c.text(l)}` : `  ${mark} ${c.text(l)}`));
  out[out.length - 1] += `   ${meta}`;
  if (!r.ok && r.output.trim()) for (const l of r.output.trimEnd().replace(/\r\n?/g, '\n').split('\n')) out.push(c.muted(`      ${plainText(l)}`));
  return out;
}

/** What verification established about the final result and each card, commands and failures whole. */
function verificationLines(d: RunDetail, g: Glyphs): string[] {
  const b: Board = d.board;
  const out: string[] = [c.accent.bold('Final verification')];
  const fv = b.finalVerification;
  switch (d.final) {
    case 'not-run': out.push(c.muted('  not yet')); break;
    case 'not-recorded': out.push(c.muted('  not recorded')); break;
    case 'none-configured': out.push(c.warn(`  ${g.warn} ${cardChecks(b) === 'none' ? 'none' : 'cards only'}`)); break;
    default: {
      out.push(c.muted(`  ${plainText(b.runBranch)} @ ${plainText(fv!.ref.slice(0, 7))}`));
      if (d.final === 'stale') out.push(c.warn(`  ${g.warn} stale · now @ ${plainText((d.tip ?? '').slice(0, 7))}`));
      for (const r of fv!.results) out.push(...resultLines(r, g));
    }
  }
  out.push('', c.accent.bold('Cards'));
  if (!b.cards.length) out.push(c.muted('  none'));
  for (const card of b.cards) {
    const lk = cardLook(card, g);
    const faded = card.status === 'replaced';
    out.push(`${(faded ? c.faint : lk.paint)(lk.glyph)} ${(faded ? c.faint : c.text.bold)(plainText(card.id))}  ${(faded ? c.faint : c.text)(plainText(card.title))}`);
    if (!card.verify.length) out.push(c.muted('  no verify commands'));
    else if (!card.verification?.length) {
      for (const cmd of card.verify) out.push(`  ${c.muted(g.dot)} ${c.text(plainText(cmd))}${c.faint('   not run')}`);
    } else for (const r of card.verification) out.push(...resultLines(r, g));
  }
  return out;
}
