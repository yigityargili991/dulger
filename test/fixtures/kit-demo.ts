// A gallery of every kit widget inside the real app shell: `node test/fixtures/kit-demo.ts`.
// Also reference code for page authors: each page below is a complete, small Page implementation, drawn
// the lean way: labels, values and glyphs on the page, at most four keys in the footer, explanations in
// help (`?`), dialogs with the facts and the buttons, toasts of a few words.
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, type Config } from '../../src/config.ts';
import { createApp } from '../../src/app/shell.ts';
import type { AppContext, HelpGroup, Page, PageFactory } from '../../src/app/types.ts';
import { openScreen } from '../../src/tui/screen.ts';
import { c, resolveIcons, status } from '../../src/tui/theme.ts';
import {
  badge, breadcrumb, compose, createForm, createInput, createList, createScroll, createTable, createTextarea, emptyState, fieldHelp,
  formCapturesText, formFields, formHeight, formHints, formKey, formMouse, formWidth, hit, inputKey, inputValue, listCapturesText, listKey, listMouse,
  listScroll, panel, pill, progress, renderForm, renderInput, renderList, renderScroll, renderTable, renderTabs, renderTextarea,
  scrollInfo, scrollKey, scrollMouse, scrollPosition, selectedItem, selectedRow, spinnerFrame, splitCols, splitRows, tableKey, tableMouse,
  tableScroll, textareaKey, textareaValue, toggleWrap, type FormSection, type ListItem, type Rect, type Size,
} from '../../src/tui/kit/index.ts';

const config = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), harness: 'fake' });

// ---- Lists: a filterable list and a table side by side; Tab moves the focus between them ----

function listsPage(ctx: AppContext): Page {
  const g = ctx.g;
  const states = ['done', 'in_progress', 'review', 'failed', 'backlog', 'blocked'] as const;
  const items: ListItem[] = Array.from({ length: 60 }, (_, i) => {
    const st = states[i % states.length]!;
    return { id: `r${i + 1}`, label: i === 3 ? '日本語のゴール 👩‍💻 wide text' : `Goal ${i + 1}: ${['add a /health endpoint', 'fix the flaky test', 'write the docs', 'refactor the scheduler'][i % 4]}`,
      detail: `r${i + 1}`, meta: `${(i * 7) % 60}m ago`, icon: status[st](st === 'done' ? g.check : st === 'failed' ? g.cross : g.dot), disabled: i === 5 };
  });
  const list = createList(items, { filter: 'slash', empty: 'No runs' });
  const table = createTable([
    { title: 'Card', width: 4 },
    { title: 'Title', flex: 1, min: 10 },
    { title: 'Status', width: 11 },
    { title: 'Cost', width: 7, align: 'right' },
    { title: 'Turns', width: 5, align: 'right', optional: true },
  ], Array.from({ length: 25 }, (_, i) => ({
    id: `c${i + 1}`,
    cells: [`c${i + 1}`, ['Parse the config', 'Add the endpoint', 'Write tests', 'Update docs'][i % 4]!, ['done', 'in progress', 'failed'][i % 3]!, `$${(i * 0.37).toFixed(2)}`, String(i * 3)],
    tones: [undefined, undefined, (['ok', 'warn', 'bad'] as const)[i % 3], 'muted', 'muted'],
  })));
  let focus: 'list' | 'table' = 'list';
  let rects: { list: Rect; table: Rect } = { list: { top: 0, left: 0, rows: 0, cols: 0 }, table: { top: 0, left: 0, rows: 0, cols: 0 } };

  const open = (id: string) => ctx.push(detailPage(ctx, id));
  return {
    id: 'lists', title: 'Lists',
    badge: () => `${g.running}${items.filter((it) => it.label.includes('flaky')).length}`,
    render(size) {
      const area = { top: 0, left: 0, ...size };
      const [l, r] = size.cols >= 90 ? splitCols(area, [{ flex: 1 }, { flex: 1 }], 1) : splitRows(area, [{ flex: 1 }, { flex: 1 }]);
      rects = { list: l!, table: r! };
      return compose(size, [
        { rect: l!, block: panel(l!, { g, title: 'Runs', focused: focus === 'list', badge: c.muted(String(items.length)), scroll: () => listScroll(list) }, (inner) => renderList(list, inner, g, { focused: focus === 'list' })) },
        { rect: r!, block: panel(r!, { g, title: 'Cards', focused: focus === 'table', scroll: () => tableScroll(table), footer: () => c.muted(`${table.index + 1}/${table.rows.length}`) }, (inner) => renderTable(table, inner, g, { focused: focus === 'table' })) },
      ]);
    },
    onKey(k) {
      if (k.name === 'tab' || k.name === 'shift-tab') { focus = focus === 'list' ? 'table' : 'list'; return true; }
      if (focus === 'list') {
        if (listKey(list, k)) return true;
        if (k.name === 'enter') { const it = selectedItem(list); if (it && !it.disabled) open(it.id); return true; }
        return false;
      }
      if (tableKey(table, k)) return true;
      if (k.name === 'enter') { ctx.toast(`Card ${selectedRow(table)?.id} opened`, 'info'); return true; }
      return false;
    },
    onMouse(m) {
      const inList = hit(m, rects.list);
      const inTable = hit(m, rects.table);
      // Panel content starts one row down and two columns in (border + padding).
      if (inList) { focus = 'list'; const r = listMouse(list, { ...inList, row: inList.row - 1, col: inList.col - 2 }); if (r === 'activate') { const it = selectedItem(list); if (it) open(it.id); } return true; }
      if (inTable) { focus = 'table'; tableMouse(table, { ...inTable, row: inTable.row - 1, col: inTable.col - 2 }); return true; }
      return false;
    },
    hints: () => focus === 'list'
      ? [{ key: '↑↓', label: 'move' }, { key: '/', label: 'filter' }, { key: g.enter, label: 'open' }, { key: 'tab', label: 'cards' }]
      : [{ key: '↑↓', label: 'move' }, { key: g.enter, label: 'open' }, { key: 'tab', label: 'runs' }],
    capturesText: () => focus === 'list' && listCapturesText(list),
    commands: () => [
      { id: 'filter', title: 'Filter runs', shortcut: '/', run: () => { focus = 'list'; list.filtering = true; } },
      { id: 'suspend', title: 'Run a shell command (suspend)', description: 'Gives the terminal away, runs `ls`, then comes back.', run: async () => {
        await ctx.suspend(() => { spawnSync('sh', ['-c', 'ls; echo; echo "back to the app in 1s"; sleep 1'], { stdio: 'inherit' }); });
        ctx.toast('Back', 'ok');
      } },
    ],
  };
}

function detailPage(ctx: AppContext, id: string): Page {
  const scroll = createScroll(Array.from({ length: 80 }, (_, i) => `${id} line ${i + 1}: ${'detail '.repeat((i % 7) + 1)}`).join('\n'));
  return {
    id: `detail-${id}`, title: id,
    render: (size) => panel(size, { g: ctx.g, title: `Run ${id}`, focused: true, footer: () => c.muted(scrollPosition(scroll)), scroll: () => scrollInfo(scroll) },
      (inner) => renderScroll(scroll, inner, ctx.g, { scrollbar: false })),
    onKey: (k) => scrollKey(scroll, k),
    onMouse: (m) => scrollMouse(scroll, m),
    hints: () => [{ key: '↑↓', label: 'scroll' }],
  };
}

// ---- Form: every field kind ----

function formPage(ctx: AppContext): Page {
  const sections: FormSection[] = [
    { title: 'Session', fields: [
      { kind: 'choice', key: 'harness', label: 'Harness', value: 'claude', description: 'Which backend runs the agents.',
        options: [{ value: 'claude', label: 'claude', description: 'Claude Code CLI' }, { value: 'codex', label: 'codex', description: 'Codex CLI' }, { value: 'fake', label: 'fake', description: 'No model calls' }, { value: 'openai', label: 'openai' }, { value: 'ollama', label: 'ollama' }, { value: 'deepseek', label: 'deepseek' }, { value: 'groq', label: 'groq' }, { value: 'mistral', label: 'mistral' }] },
      { kind: 'number', key: 'concurrency', label: 'Concurrency', value: 3, min: 1, max: 16, description: 'How many agents work at once.' },
      { kind: 'number', key: 'attempts', label: 'Attempts per card', value: 2, min: 1, max: 9, changed: true, description: 'How many tries a card gets before it fails.' },
      { kind: 'toggle', key: 'docs', label: 'Docs agent', value: true, description: 'Update documentation after the cards land.' },
      { kind: 'toggle', key: 'routing', label: 'Routing', value: false, on: 'auto tiers', off: 'pinned', tag: 'session', description: 'Pick the model by card difficulty. Session only: never saved.' },
    ] },
    { title: 'Limits', fields: [
      { kind: 'number', key: 'budget', label: 'Run budget', value: undefined, optional: true, prefix: '$', decimals: 2, step: 0.5, min: 0.5, description: 'Stop the run (resumable) once its spend reaches this. Off: no limit.' },
      { kind: 'number', key: 'stall', label: 'Stall timeout', value: 600, min: 30, max: 7200, step: 30, unit: 's', description: 'Seconds without output before an agent counts as stalled.' },
    ] },
    { title: 'Provider', fields: [
      { kind: 'text', key: 'baseUrl', label: 'Base URL', value: 'https://api.openai.com/v1', placeholder: 'https://…', description: 'The endpoint of the OpenAI-compatible API.',
        validate: (v) => (/^https?:\/\//.test(v) ? undefined : 'Must start with http:// or https://') },
      { kind: 'secret', key: 'key', label: 'API key', value: '', placeholder: 'not set', description: 'Stored in your user keys file, never in the repository.' },
      { kind: 'info', key: 'source', label: 'Key source', value: 'environment (OPENAI_API_KEY)', tone: 'ok' },
      { kind: 'toggle', key: 'locked', label: 'Sandbox', value: true, disabled: 'set by your user config' },
    ] },
  ];
  // A disabled field says why only when it is tried.
  const form = createForm(sections, { onRefuse: (reason) => ctx.toast(reason, 'info') });
  const changed = () => formFields(form).filter((f) => f.changed).length;
  // Save and reset are keys, not rows of buttons.
  const save = () => { void ctx.busy('Saving', new Promise((res) => setTimeout(res, 1200))).then(() => ctx.toast('Saved', 'ok')); };
  const reset = () => {
    const items = formFields(form).filter((f) => f.changed).map((f) => f.label);
    void ctx.confirm({ title: 'Reset session', message: '', items: items.length ? items : ['nothing changed'], confirm: 'Reset', danger: true })
      .then((yes) => { if (yes) ctx.toast('Reset', 'warn'); });
  };
  return {
    id: 'form', title: 'Form',
    render(size) {
      // As wide and as tall as the form needs, not the terminal; ✎n counts the changed fields.
      const cols = Math.min(size.cols, formWidth(form, ctx.g) + 4);
      const rect = { top: 0, left: 0, rows: Math.min(size.rows, formHeight(form, Math.max(1, cols - 4), ctx.g) + 2), cols };
      const n = changed();
      return compose(size, [{ rect, block: panel(rect, { g: ctx.g, title: 'Settings', focused: true, badge: n ? c.warn(`${ctx.g.modified}${n}`) : undefined }, (inner) => renderForm(form, inner, ctx.g)) }]);
    },
    onKey(k) {
      const r = formKey(form, k);
      if (typeof r === 'object') {
        if (r.type === 'change') r.field.changed = true;
        return true;
      }
      if (r) return true;
      if (k.name === 'char' && k.ch === 's') { save(); return true; }
      if (k.name === 'char' && k.ch === 'r') { reset(); return true; }
      return false;
    },
    onMouse: (m) => {
      const r = formMouse(form, { ...m, row: m.row - 1, col: m.col - 2 });
      if (typeof r === 'object' && r.type === 'change') r.field.changed = true;
      return r !== false;
    },
    hints: () => (formCapturesText(form) ? formHints(form) : [...formHints(form).slice(0, 2), { key: 's', label: 'save' }]),
    // The focused field first (its label and description), then the keys.
    help: (): HelpGroup[] => [
      ...[fieldHelp(form)].filter((x) => x !== undefined),
      { title: 'Keys', keys: [{ key: 's', label: 'save' }, { key: 'r', label: 'reset the session' }] },
    ],
    capturesText: () => formCapturesText(form),
  };
}

// ---- Text: an input and a text area ----

function textPage(ctx: AppContext): Page {
  const input = createInput({ placeholder: 'What should the agents build?' });
  const secret = createInput({ placeholder: 'key', mask: true });
  const area = createTextarea({ placeholder: 'instructions', value: 'A text area with soft wrap: '.concat('long words wrap at spaces and the cursor keeps its column on ↑ and ↓. '.repeat(3)) });
  let focus = 0;
  return {
    id: 'text', title: 'Text',
    render(size) {
      const [a, b, t] = splitRows({ top: 0, left: 0, ...size }, [3, 3, { flex: 1 }]);
      // Widgets only report a cursor while focused, so the focused field's cursor is the one kept.
      const line = (s: typeof input, i: number) => (inner: Size) => {
        const r = renderInput(s, inner.cols, { focused: focus === i });
        return { lines: [r.line], cursor: r.cursor === undefined ? undefined : { row: 0, col: r.cursor } };
      };
      const box = (r: Rect, title: string, i: number, body: Parameters<typeof panel>[2]) => ({ rect: r, block: panel(r, { g: ctx.g, title, focused: focus === i }, body) });
      return compose(size, [
        box(a!, 'Goal', 0, line(input, 0)),
        box(b!, 'Secret', 1, line(secret, 1)),
        box(t!, 'Notes', 2, (inner) => renderTextarea(area, inner, { focused: focus === 2 })),
      ]);
    },
    onKey(k) {
      if (k.name === 'tab') { focus = (focus + 1) % 3; return true; }
      if (k.name === 'shift-tab') { focus = (focus + 2) % 3; return true; }
      if (focus === 2) {
        const r = textareaKey(area, k);
        if (r === 'submit') { ctx.toast(`${textareaValue(area).split('\n').length} lines`, 'ok'); return true; }
        return r;
      }
      const target = focus === 0 ? input : secret;
      const r = inputKey(target, k);
      if (r === 'submit') { ctx.toast(focus === 0 ? inputValue(input) || 'empty' : 'Key set', 'ok'); return true; }
      return r;
    },
    hints: () => [{ key: 'tab', label: 'next' }, { key: focus === 2 ? '^s' : 'enter', label: 'submit' }],
    capturesText: () => true,
  };
}

// ---- Viewer: a diff in a scroll view ----

const DIFF = `diff --git a/src/server.ts b/src/server.ts
index 3b18e51..a9c4f2d 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,9 +1,14 @@ import { createServer } from 'node:http';
 import { createServer } from 'node:http';
+import { health } from './health.ts';

 const server = createServer((req, res) => {
-  res.end('ok');
+  if (req.url === '/health') {
+\treturn health(res);
+  }
+  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found — this line is deliberately long so that it needs horizontal scrolling or wrapping to be read whole');
 });

 server.listen(3000);
diff --git a/src/health.ts b/src/health.ts
new file mode 100644
--- /dev/null
+++ b/src/health.ts
@@ -0,0 +1,5 @@
+import type { ServerResponse } from 'node:http';
+
+export function health(res: ServerResponse): void {
+  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
+}
\\ No newline at end of file
`;

function viewerPage(ctx: AppContext): Page {
  const scroll = createScroll(DIFF.repeat(4), { diff: true, wrap: false });
  return {
    id: 'viewer', title: 'Diff',
    render: (size) => panel(size, { g: ctx.g, title: 'src/server.ts', focused: true, badge: badge(scroll.wrap ? 'wrap' : 'no wrap'), footer: () => c.muted(scrollPosition(scroll)), scroll: () => scrollInfo(scroll) },
      (inner) => renderScroll(scroll, inner, ctx.g, { focused: true })),
    onKey(k) {
      if (k.name === 'char' && k.ch === 'w') { toggleWrap(scroll); return true; }
      return scrollKey(scroll, k);
    },
    onMouse: (m) => scrollMouse(scroll, m),
    hints: () => [{ key: '↑↓', label: 'scroll' }, { key: '←→', label: 'pan' }, { key: 'w', label: 'wrap' }],
  };
}

// ---- Modals: a menu that opens each kind ----

function modalsPage(ctx: AppContext): Page {
  // Dialogs state what will happen as data (items, detail), not as prose; one short line at most for a
  // consequence the person would regret.
  const actions: Array<{ id: string; label: string; detail: string; run(): Promise<unknown> }> = [
    { id: 'confirm', label: 'Confirm', detail: 'safe first', run: () => ctx.confirm({ title: 'Merge run r12', message: 'dulger/r12 → master', confirm: 'Merge' }).then((v) => ctx.toast(`confirm → ${v}`)) },
    { id: 'danger', label: 'Confirm (danger)', detail: 'red', run: () => ctx.confirm({ title: 'Delete run r12', message: 'Cannot be undone.', items: [{ label: 'Worktrees', value: '3' }, { label: 'Branches', value: 'dulger/r12, dulger/r12-c1…c3' }], confirm: 'Delete', danger: true }).then((v) => ctx.toast(`danger → ${v}`, v ? 'warn' : 'info')) },
    { id: 'typed', label: 'Confirm (typed)', detail: 'typed word', run: () => ctx.confirm({ title: 'Stop card c3', message: '', items: [{ label: 'Kept', value: 'completed work' }], confirm: 'Stop', danger: true, typed: 'stop' }).then((v) => ctx.toast(`typed → ${v}`)) },
    { id: 'prompt', label: 'Prompt', detail: 'one line', run: () => ctx.prompt({ title: 'New goal', placeholder: 'What should the agents build?', validate: (v) => (v.trim().split(/\s+/).length < 3 ? 'At least three words' : undefined) }).then((v) => ctx.toast(`prompt → ${v ?? 'cancelled'}`)) },
    { id: 'multi', label: 'Prompt (multi-line)', detail: 'text area', run: () => ctx.prompt({ title: 'Instructions for c3', placeholder: 'instructions', multiline: true }).then((v) => ctx.toast(`multi → ${v === undefined ? 'cancelled' : `${v.split('\n').length} lines`}`)) },
    { id: 'secret', label: 'Prompt (secret)', detail: 'masked', run: () => ctx.prompt({ title: 'openai key', secret: true }).then((v) => ctx.toast(v ? 'Key set' : 'cancelled')) },
    { id: 'pick', label: 'Picker', detail: 'single', run: () => ctx.pick({ title: 'Worker model', options: ['haiku', 'sonnet', 'fable', 'opus', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'deepseek-flash', 'qwen3:8b', 'llama3.3:70b'].map((m) => ({ value: m, label: m, meta: m.includes('gpt') ? 'codex' : m.includes(':') ? 'ollama' : 'claude' })), selected: 'sonnet' }).then((v) => ctx.toast(`pick → ${v ?? 'cancelled'}`)) },
    { id: 'pickmany', label: 'Picker (multi)', detail: 'multi', run: () => ctx.pickMany({ title: 'Cards to retry', options: ['c2 Parse the config', 'c4 Write tests', 'c7 Update docs'].map((t) => ({ value: t.split(' ')[0]!, label: t })) }).then((v) => ctx.toast(`many → ${v?.join(', ') ?? 'cancelled'}`)) },
    { id: 'view', label: 'Viewer', detail: 'diff', run: () => ctx.view({ title: 'git diff master...dulger/r12', text: DIFF.repeat(3), diff: true }) },
    { id: 'busy', label: 'Busy', detail: '2 s', run: () => ctx.busy('ollama: listing models', new Promise((res) => setTimeout(res, 2000))).then(() => ctx.toast('Done', 'ok')) },
    { id: 'toasts', label: 'Toasts', detail: 'each kind', run: async () => { ctx.toast('Saved', 'ok'); ctx.toast('Nothing to save', 'info'); ctx.toast('Budget 90% spent', 'warn'); ctx.toast('connect ECONNREFUSED 127.0.0.1:11434', 'error'); } },
  ];
  const list = createList(actions.map((a) => ({ id: a.id, label: a.label, detail: a.detail })));
  const run = () => { const a = actions.find((x) => x.id === selectedItem(list)?.id); if (a) void a.run(); };
  return {
    id: 'modals', title: 'Modals',
    render: (size) => panel(size, { g: ctx.g, title: 'Open a modal', focused: true }, (inner) => renderList(list, inner, ctx.g, { focused: true })),
    onKey(k) {
      if (listKey(list, k)) return true;
      if (k.name === 'enter') { run(); return true; }
      return false;
    },
    onMouse(m) { if (listMouse(list, { ...m, row: m.row - 1, col: m.col - 2 }) === 'activate') run(); return true; },
    hints: () => [{ key: '↑↓', label: 'move' }, { key: ctx.g.enter, label: 'open' }],
    commands: () => actions.map((a) => ({ id: a.id, title: `Open ${a.label}`, description: a.detail, run: a.run })),
  };
}

// ---- Bits: pills, progress, spinner, breadcrumb, tabs, empty state ----

function bitsPage(ctx: AppContext): Page {
  const g = ctx.g;
  const started = ctx.now();
  return {
    id: 'bits', title: 'Bits',
    animating: () => true,
    render(size) {
      const area = { top: 0, left: 0, ...size };
      const [top, bottom] = splitRows(area, [{ flex: 3 }, { flex: 2 }]);
      const t = ctx.now() - started;
      const ratio = ((t / 50) % 100) / 100;
      return compose(size, [
        { rect: top!, block: panel(top!, { g, title: 'Pieces', focused: true }, (inner) => [
          `${pill('done', 'ok')} ${pill('running', 'warn')} ${pill('failed', 'bad')} ${pill('review', 'accent')} ${pill('info', 'info')} ${pill('idle', 'muted')}`,
          '',
          `${badge('12')} ${badge(`${g.cross}3`, 'bad')} ${badge(`${g.running}2`, 'warn')} ${badge(`${g.modified}2`, 'warn')}`,
          '',
          `${c.muted('progress')}  ${progress(ratio, Math.min(40, inner.cols - 12), g)}`,
          `${c.muted('tasks   ')}  ${progress(3 / 7, Math.min(40, inner.cols - 12), g, { tone: 'ok' })}`,
          '',
          `${c.muted('spinner ')}  ${c.accent(spinnerFrame(g, t))} ${c.text('planning the board')}`,
          '',
          `${c.muted('crumbs  ')}  ${breadcrumb(['Runs', 'r12', 'c3', 'diff'], g, Math.max(10, inner.cols - 12))}`,
          '',
          renderTabs([{ id: 'a', title: 'Board' }, { id: 'b', title: 'Report' }, { id: 'c', title: 'Diff', badge: '3' }], 1, inner.cols, { numbers: false }).line,
        ]) },
        { rect: bottom!, block: panel(bottom!, { g, title: 'Empty state' }, (inner) => emptyState(inner, { title: 'No runs yet' }, g)) },
      ]);
    },
    onKey: () => false,
    hints: () => [],
  };
}

const pages: PageFactory[] = [listsPage, formPage, textPage, viewerPage, modalsPage, bitsPage];
const app = createApp({
  repoRoot: process.cwd(),
  session: { overrides: { harness: 'fake' }, yes: false, quiet: false, allowDirty: false },
  version: 'demo',
  config,
  pages,
  icons: resolveIcons('auto'),
  branch: () => 'kit-demo',
  openScreen: () => openScreen(process.stdout, process.stdin, { mouse: process.env.DULGER_DEMO_MOUSE !== '0' }),
});
await app.run();
