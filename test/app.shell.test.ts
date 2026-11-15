import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { createApp } from '../src/app/shell.ts';
import { PAGES } from '../src/app/pages/index.ts';
import type { AppContext, Page, PageFactory } from '../src/app/types.ts';
import { openScreen, type Key, type Screen } from '../src/tui/screen.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, press, wheel } from './kit.helpers.ts';

// The app reads the user's own config file: keep the real one out of these tests.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-shell-home-'));
const config = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), harness: 'fake' });
const session = { overrides: {}, yes: false, quiet: false, allowDirty: false };

interface Probe { log: string[]; keys: Key[]; ctx?: AppContext; mice: Array<{ row: number; kind: string }> }

/** A page that records what the shell does to it and consumes the keys `eats` says. */
function probe(id: string, title: string, p: Probe, o: { eats?: (k: Key) => boolean; captures?: () => boolean; extra?: Partial<Page> } = {}): PageFactory {
  return (ctx) => {
    p.ctx = ctx;
    return {
      id, title,
      activate: (params) => { p.log.push(`activate ${id}${params ? ` ${JSON.stringify(params)}` : ''}`); },
      deactivate: () => { p.log.push(`deactivate ${id}`); },
      render: (size) => ({ lines: [`${title} body ${size.rows}x${size.cols}`], cursor: { row: 0, col: 1 } }),
      onKey: (k) => { p.keys.push(k); return o.eats?.(k) ?? false; },
      onMouse: (m) => { p.mice.push({ row: m.row, kind: m.kind }); return true; },
      hints: () => [{ key: 'x', label: `${id} action` }],
      capturesText: o.captures,
      ...o.extra,
    };
  };
}

function setup(o: { eats?: (k: Key) => boolean; captures?: () => boolean; extra?: Partial<Page>; rows?: number; cols?: number } = {}) {
  const p: Probe = { log: [], keys: [], mice: [] };
  const screens = fakeScreens(o.rows ?? 24, o.cols ?? 100);
  let t = 1_000_000;
  const clock = { get now() { return t; }, advance(ms: number) { t += ms; } };
  const pages = [probe('home', 'Home', p, o), probe('runs', 'Runs', { log: p.log, keys: [], mice: [] }), probe('settings', 'Settings', { log: p.log, keys: [], mice: [] })];
  const app = createApp({ repoRoot: '/tmp/my-repo', session: { ...session }, version: '9.9.9', config, pages, openScreen: screens.factory, icons: 'unicode', now: () => t, branch: () => 'main' });
  const done = app.run();
  return { app, p, screens, clock, done, get s() { return screens.current; }, ctx: p.ctx! };
}

test('layout: header with repo, branch, backend and sandbox; tabs; the page body; a key bar', async () => {
  const { s, app, done } = setup();
  const lines = s.text.split('\n');
  assert.match(lines[0]!, /dulger .*my-repo .*⎇ main .*fake · sandbox \w+ $/, 'the backend and the sandbox; no version, no routing while it is on');
  assert.doesNotMatch(lines[0]!, /9\.9\.9|routing/);
  assert.match(lines[1]!, /\[1 Home\]\s+2 Runs\s+3 Settings/);
  assert.equal(lines[2], 'Home body 21x100'.padEnd(100));
  assert.match(lines[23]!, /^ x home action  \? help\s*$/, 'the page\'s keys and ? help: no page name, no ^p, no quit');
  assert.deepEqual(s.cursor, { row: 2, col: 1 }, 'the page cursor is moved into screen coordinates');
  app.quit();
  await done;
  assert.equal(s.closed, 1);
});

test('every size fits, down to 1×1, and a resize repaints', async () => {
  const { s, app, done } = setup();
  for (const [rows, cols] of SIZES) {
    s.resize(rows, cols);
    assertFrame(s.lines, rows, cols, 'shell');
  }
  s.resize(3, 40);
  assert.match(s.text, /Home body 1x40/, 'with 3 rows: header, body, footer');
  s.resize(1, 40);
  assert.match(s.text, /Home body 1x40/, 'with 1 row only the body is left');
  app.quit();
  await done;
});

test('keys reach the page first; unused ones switch tabs, unless the page captures text', async () => {
  let capturing = false;
  const { s, p, app, done } = setup({ eats: (k) => k.name === 'char' && k.ch === 'e', captures: () => capturing });
  s.key(ch('e'));
  assert.equal(p.keys.length, 1);
  assert.match(s.text, /\[1 Home\]/, 'a used key does nothing else');
  s.key(ch('2'));
  assert.match(s.text, /\[2 Runs\]/);
  s.key(ch('['));
  assert.match(s.text, /\[1 Home\]/);
  s.key(ch('['));
  assert.match(s.text, /\[3 Settings\]/, '[ wraps around');
  s.key(ch(']'));
  assert.match(s.text, /\[1 Home\]/);
  capturing = true;
  s.key(ch('3'));
  s.key(ch('q'));
  s.key(ch('?'));
  assert.match(s.text, /\[1 Home\]/, 'while capturing, digits, q and ? are the page\'s');
  assert.doesNotMatch(s.text, /─ Help ─/);
  s.key({ name: 'alt', ch: '3' });
  assert.match(s.text, /\[3 Settings\]/, 'Alt-digit always switches');
  s.key({ name: 'alt-left' });
  assert.match(s.text, /\[2 Runs\]/);
  assert.deepEqual(p.log, ['activate home', 'deactivate home', 'activate runs', 'deactivate runs', 'activate home', 'deactivate home', 'activate settings',
    'deactivate settings', 'activate home', 'deactivate home', 'activate settings', 'deactivate settings', 'activate runs']);
  app.quit();
  await done;
});

test('q and Ctrl-D quit; Ctrl-C asks once, then quits on a second press in time', async () => {
  {
    const { s, done } = setup();
    s.key(ch('q'));
    await done;
    assert.equal(s.closed, 1);
  }
  {
    const { s, done } = setup();
    s.key(key('ctrl', 'd'));
    await done;
  }
  {
    const { s, clock, done, app } = setup();
    let quit = false;
    void done.then(() => { quit = true; });
    s.key(key('ctrl', 'c'));
    await sleep(0);
    assert.equal(quit, false);
    assert.match(s.text, /\^c again quits/);
    clock.advance(2500);
    s.key(key('ctrl', 'c'));
    await sleep(0);
    assert.equal(quit, false, 'too late: it asks again');
    clock.advance(500);
    s.key(key('ctrl', 'c'));
    await done;
    assert.equal(quit, true);
    app.quit();
  }
});

test('modals get every key; confirm, prompt, pick and pickMany resolve with the answer', async () => {
  const { s, p, ctx, app, done } = setup();
  const yes = ctx.confirm({ title: 'Merge', message: 'Merge it?' });
  assert.match(s.text, /Merge it\?/);
  s.key(ch('2'));
  assert.match(s.text, /\[1 Home\]/, 'the modal swallowed the digit');
  assert.equal(p.keys.length, 0, 'the page saw nothing');
  s.key(key('right'));
  s.key(key('enter'));
  assert.equal(await yes, true);
  const no = ctx.confirm({ title: 'Delete', message: 'Delete it?', danger: true });
  s.key(key('enter'));
  assert.equal(await no, false, 'Enter on the safe default cancels');
  const name = ctx.prompt({ title: 'Name' });
  s.type('r12');
  s.key(key('enter'));
  assert.equal(await name, 'r12');
  const picked = ctx.pick({ title: 'Model', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
  s.key(key('down'));
  s.key(key('enter'));
  assert.equal(await picked, 'b');
  const many = ctx.pickMany({ title: 'Cards', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
  s.key(ch(' '));
  s.key(key('down'));
  s.key(ch(' '));
  s.key(key('enter'));
  assert.deepEqual(await many, ['a', 'b']);
  const viewed = ctx.view({ title: 'Report', text: 'long\ntext' });
  assert.match(s.text, /Report/);
  s.key(key('escape'));
  await viewed;
  const pending = [ctx.confirm({ title: 'a', message: 'b' }), ctx.prompt({ title: 'c' }), ctx.pick({ title: 'd', options: [] })];
  app.quit();
  assert.deepEqual(await Promise.all(pending), [false, undefined, undefined], 'quitting settles open modals with their cancel');
  await done;
  assert.equal(await ctx.confirm({ title: 'late', message: 'x' }), false, 'after quitting, modals settle at once');
});

test('push and pop: breadcrumb, Esc pops, activation follows visibility; navigate clears and passes params', async () => {
  const { s, p, ctx, app, done } = setup();
  const sub: Page = { id: 'r12', title: 'r12', render: () => ({ lines: ['sub page'] }), onKey: () => false, hints: () => [],
    activate: () => { p.log.push('activate r12'); }, deactivate: () => { p.log.push('deactivate r12'); } };
  ctx.push(sub);
  assert.match(s.text, /sub page/);
  assert.match(s.lines.at(-1)!, /^ Home › r12  esc back  \? help/, 'a pushed page keeps its breadcrumb, with esc back');
  s.key(key('escape'));
  assert.match(s.text, /Home body/);
  ctx.push(sub);
  s.key(ch('2'));
  s.key(ch('['));
  assert.match(s.text, /\[1 Home\][\s\S]*sub page/, 'over a pushed page bare digits and [ ] are not tab switches');
  s.key({ name: 'alt', ch: '2' });
  assert.match(s.text, /\[2 Runs\]/, 'Alt-digit always is');
  s.key(ch('1'));
  assert.match(s.text, /sub page/, 'each tab keeps its own stack');
  ctx.navigate('home', { run: 'r7' });
  assert.match(s.text, /Home body/, 'navigate closes what was pushed');
  assert.ok(p.log.includes('activate home {"run":"r7"}'));
  ctx.navigate('nowhere');
  assert.match(s.text, /No page called nowhere/);
  assert.deepEqual(p.log.slice(0, 6), ['activate home', 'deactivate home', 'activate r12', 'deactivate r12', 'activate home', 'deactivate home']);
  app.quit();
  await done;
});

test('palette: tabs, global actions and page commands, fuzzy-filtered; a failing command is a toast', async () => {
  let ran = 0;
  const { s, ctx, app, done } = setup({ extra: { commands: () => [
    { id: 'resume', title: 'Resume latest run', run: () => { ran++; } },
    { id: 'boom', title: 'Explode', run: async () => { throw new Error('it broke'); } },
  ] } });
  s.key(key('ctrl', 'p'));
  assert.match(s.text, /Commands/);
  assert.match(s.text, /❯ Resume latest run[\s\S]*Go to Home\s+1/, 'page commands come first, without the page\'s name; navigation needs no prefix');
  assert.doesNotMatch(s.text, /Home: |Navigation: /);
  s.type('go set');
  s.key(key('enter'));
  await sleep(0);
  assert.match(s.text, /\[3 Settings\]/);
  s.key(ch('1'));
  s.key(ch(':'));
  s.type('resume');
  s.key(key('enter'));
  await sleep(0);
  assert.equal(ran, 1);
  s.key(key('ctrl', 'p'));
  s.type('explode');
  s.key(key('enter'));
  await sleep(0);
  await sleep(0);
  assert.match(s.text, /it broke/);
  s.key(key('ctrl', 'p'));
  s.key(key('ctrl', 'p'));
  assert.doesNotMatch(s.text, /Commands/, 'Ctrl-P again closes it');
  void ctx;
  app.quit();
  await done;
});

test('help lists the page\'s keys and the global ones; ? and F1 open it', async () => {
  const { s, app, done } = setup();
  s.key(ch('?'));
  assert.match(s.text, /─ Help ─/);
  assert.match(s.text, /home action/);
  assert.match(s.text, /switch tab/);
  s.key(key('escape'));
  s.key(key('f1'));
  assert.match(s.text, /─ Help ─/);
  s.key(ch('q'));
  assert.doesNotMatch(s.text, /switch tab/, 'q closes help, it does not quit');
  app.quit();
  await done;
});

test('toasts show above the footer and expire with the clock', async () => {
  const { s, ctx, clock, app, done } = setup();
  ctx.toast('Settings saved', 'ok');
  const row = s.text.split('\n').findIndex((l) => l.includes('Settings saved'));
  assert.equal(row, 1, 'top right, on the tab row beside the tabs, where nothing is');
  assert.match(s.text.split('\n')[1]!, /\[1 Home\]\s+2 Runs\s+3 Settings\s+.*✓ Settings saved/, 'the tabs stay readable');
  assert.match(s.text, /✓ Settings saved/);
  const long = '/tmp/claude-1000/-home-yigit-yargili-Documents-dev-dulger/90e96d89-2999-481c-ae1e-e174c4b22d83/scratchpad/walk/config/dulger/keys.json';
  ctx.toast(`Key stored in ${long}`, 'ok');
  const toastText = s.text.split('\n').filter((l) => l.includes('▌')).map((l) => l.slice(l.lastIndexOf('▌') + 1).replace(/^\s*[✓i]?\s*/, '').trimEnd()).join('');
  assert.ok(toastText.replace(/\s/g, '').includes(`Key stored in ${long}`.replace(/\s/g, '')), `a long path is wrapped whole, not cut: ${toastText}`);
  assert.doesNotMatch(s.lines.slice(-2).join('\n'), /keys\.json/, 'and never over the bottom rows');
  clock.advance(3500);
  ctx.redraw();
  assert.doesNotMatch(s.text, /Settings saved/);
  app.quit();
  await done;
});

test('lend keeps the terminal and lets another view draw on it; closing that view gives it back to the app', async () => {
  const { screens, p, ctx, app, done } = setup();
  const mine = screens.current;
  p.log.length = 0;
  const got: string[] = [];
  const result = await ctx.lend(async (open) => {
    assert.ok(open, 'the app has a terminal to lend');
    assert.deepEqual(p.log, ['deactivate home'], 'the page is put away');
    const view = open();
    assert.equal(view.rows, 24);
    view.onKey((k) => got.push(k.name === 'char' ? k.ch : k.name));
    view.paint(['the run view'], undefined);
    assert.match(mine.text, /^the run view/, 'it draws on the app\'s own screen');
    mine.key(ch('2'));
    view.close();
    view.paint(['after close'], undefined);
    mine.key(ch('3'));
    assert.match(mine.text, /^the run view/, 'a closed view draws nothing');
    // The plan editor opened from the run view borrows it too, and gives it back the same way.
    const again = open();
    again.onKey((k) => got.push(`again:${k.name === 'char' ? k.ch : k.name}`));
    mine.key(ch('4'));
    again.close();
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(got, ['2', 'again:4'], 'keys went to the borrower while it was open, and to nobody after');
  assert.equal(screens.made.length, 1, 'no second screen: the terminal never left full-screen mode');
  assert.equal(mine.closed, 0);
  assert.deepEqual(p.log, ['deactivate home', 'activate home']);
  assert.match(mine.text, /\[1 Home\][\s\S]*Home body/, 'the app painted itself back');
  mine.key(ch('2'));
  assert.match(mine.text, /\[2 Runs\]/, 'and has its keys again');
  await assert.rejects(ctx.lend(() => { throw new Error('the run failed'); }), /the run failed/);
  assert.match(mine.text, /Runs body/, 'back after a failure too');
  app.quit();
  await done;
  assert.equal(mine.closed, 1);
  assert.equal(await ctx.lend((open) => open), undefined, 'nothing to lend once the app has ended');
});

test('suspend gives the terminal away and takes it back, also when the work throws', async () => {
  const { screens, p, ctx, app, done } = setup();
  const first = screens.current;
  p.log.length = 0;
  const result = await ctx.suspend(async () => {
    assert.equal(first.closed, 1, 'the screen is closed while the work runs');
    first.key(ch('2'));
    ctx.redraw();
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(screens.made.length, 2, 'a fresh screen was opened');
  const second = screens.current;
  assert.match(second.text, /\[1 Home\]/, 'keys sent to the closed screen were ignored');
  assert.deepEqual(p.log, ['deactivate home', 'activate home'], 'the page was put away and re-activated');
  await assert.rejects(ctx.suspend(() => { throw new Error('legacy flow failed'); }), /legacy flow failed/);
  assert.equal(screens.made.length, 3, 'the terminal came back after the failure');
  assert.match(screens.current.text, /Home body/);
  second.key(ch('q'));
  screens.current.key(ch('2'));
  assert.match(screens.current.text, /\[2 Runs\]/, 'the new screen has the keys');
  app.quit();
  await done;
  assert.equal(screens.current.closed, 1);
});

test('mouse: a click on a tab switches; the wheel goes to the page or the top modal; a click outside a modal cancels it', async () => {
  const { s, p, ctx, app, done } = setup();
  const runs = s.text.split('\n')[1]!.indexOf('2 Runs');
  s.mouse(press(1, runs + 1));
  assert.match(s.text, /\[2 Runs\]/);
  s.mouse(press(1, 2));
  s.mouse(wheel('down', 5, 10));
  assert.deepEqual(p.mice, [{ row: 3, kind: 'wheel-down' }], 'rows are relative to the body');
  const answer = ctx.confirm({ title: 'Sure', message: 'Really?' });
  s.mouse(wheel('down', 5, 10));
  assert.equal(p.mice.length, 1, 'with a modal open the page gets no mouse');
  s.mouse(press(0, 0));
  assert.equal(await answer, false);
  app.quit();
  await done;
});

test('a page that throws while drawing shows an error instead of crashing; key errors become toasts', async () => {
  let broken = true;
  const { s, app, done } = setup({ extra: { render: (size) => { if (broken) throw new Error('bad data'); return { lines: [`fine ${size.rows}`] }; } }, eats: (k) => { if (k.name === 'char' && k.ch === 'z') throw new Error('key exploded'); return false; } });
  assert.match(s.text, /Home failed to draw/);
  assert.match(s.text, /bad data/);
  s.key(ch('z'));
  assert.match(s.text, /key exploded/);
  broken = false;
  s.key(ch('x'));
  assert.match(s.text, /fine 21/);
  app.quit();
  await done;
});

test('busy: quick work never flashes a spinner; slow work shows one and settles', async () => {
  const { s, ctx, app, done } = setup();
  assert.equal(await ctx.busy('Quick', Promise.resolve(7)), 7);
  assert.doesNotMatch(s.text, /Working/);
  let release = () => {};
  const slow = ctx.busy('Asking the endpoint', () => new Promise<string>((r) => { release = () => r('ok'); }));
  await sleep(160);
  assert.match(s.text, /Asking the endpoint/);
  s.key(ch('q'));
  assert.match(s.text, /Asking the endpoint/, 'keys do not dismiss it');
  release();
  assert.equal(await slow, 'ok');
  assert.doesNotMatch(s.text, /Asking the endpoint/);
  await assert.rejects(ctx.busy('Failing', Promise.reject(new Error('nope'))), /nope/);
  app.quit();
  await done;
});

test('an activate that rejects becomes a toast; the stub pages render and are listed in tab order', async () => {
  const { s, app, done } = setup({ extra: { activate: async () => { throw new Error('could not load runs'); } } });
  await sleep(0);
  await sleep(0);
  assert.match(s.text, /could not load runs/);
  app.quit();
  await done;

  const screens = fakeScreens(24, 100);
  const real = createApp({ repoRoot: '/tmp/x', session: { ...session }, version: '1.0.0', config, pages: PAGES, openScreen: screens.factory, icons: 'ascii', branch: () => 'main' });
  const running = real.run();
  assert.match(screens.current.text, /\[1 Home[^\]]*\]\s+2 Runs\s+3 Settings\s+4 Models\s+5 Providers\s+6 Memory\s+7 Doctor/);
  for (let i = 1; i <= 7; i++) {
    screens.current.key(ch(String(i)));
    assertFrame(screens.current.lines, 24, 100, `page ${i}`);
  }
  real.quit();
  await running;
});

// ---- page lifecycle: canLeave and dispose ----

/** A page that logs its lifecycle and answers canLeave with whatever `answer` says. */
function guarded(id: string, log: string[], answer: (reason: string) => boolean | Promise<boolean> = () => true, o: Partial<Page> = {}): Page {
  return {
    id, title: id, render: () => ({ lines: [`${id} body`] }), onKey: () => false, hints: () => [],
    activate: () => { log.push(`activate ${id}`); },
    deactivate: () => { log.push(`deactivate ${id}`); },
    canLeave: (reason) => { log.push(`canLeave ${id} ${reason}`); return answer(reason); },
    dispose: () => { log.push(`dispose ${id}`); },
    ...o,
  };
}

function deferred(): { promise: Promise<boolean>; resolve: (v: boolean) => void; reject: (e: Error) => void } {
  let resolve = (_v: boolean) => {};
  let reject = (_e: Error) => {};
  const promise = new Promise<boolean>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test('pop asks canLeave; a slow answer holds the page until it comes; dispose comes once, after the page below is shown', async () => {
  const { s, p, ctx, app, done } = setup();
  const log: string[] = [];
  let pending = deferred();
  ctx.push(guarded('editor', log, () => pending.promise));
  p.log.length = 0;
  s.key(key('escape'));
  assert.deepEqual(log.slice(-1), ['canLeave editor back']);
  assert.match(s.text, /editor body/, 'still showing while the question is open');
  pending.resolve(false);
  await sleep(0);
  assert.match(s.text, /editor body/, 'no: it stays');
  assert.ok(!log.includes('dispose editor'));
  pending = deferred();
  s.key(key('escape'));
  pending.resolve(true);
  await sleep(0);
  assert.match(s.text, /Home body/);
  assert.deepEqual(log.slice(-3), ['canLeave editor back', 'deactivate editor', 'dispose editor']);
  assert.deepEqual(p.log, ['activate home'], 'the page below was activated before dispose ran');
  ctx.pop();
  app.quit();
  await done;
  assert.equal(log.filter((l) => l === 'dispose editor').length, 1, 'disposed exactly once');
});

test('a canLeave that throws or rejects counts as yes and is shown; a newer request replaces an unanswered one', async () => {
  const { s, ctx, app, done } = setup();
  const log: string[] = [];
  ctx.push(guarded('a', log, () => { throw new Error('canLeave blew up'); }));
  s.key(key('escape'));
  assert.match(s.text, /Home body/, 'a throw lets the page go');
  assert.match(s.text, /canLeave blew up/);
  const slow = deferred();
  ctx.push(guarded('b', log, () => slow.promise));
  s.key(key('escape'));
  slow.reject(new Error('no answer'));
  await sleep(0);
  assert.match(s.text, /Home body/, 'a rejection lets the page go');
  const first = deferred();
  const second = deferred();
  let calls = 0;
  ctx.push(guarded('c', log, () => (++calls === 1 ? first.promise : second.promise)));
  s.key(key('escape'));
  s.key(key('escape'));
  first.resolve(true);
  await sleep(0);
  assert.match(s.text, /c body/, 'the replaced request\'s answer is ignored');
  second.resolve(false);
  await sleep(0);
  assert.match(s.text, /c body/);
  app.quit();
  await done;
});

test('navigate asks each page it would drop, over the page; a no keeps it and shows it; switching tabs never asks', async () => {
  const { s, ctx, app, done } = setup();
  const log: string[] = [];
  let ok = false;
  ctx.push(guarded('form', log, () => ok));
  s.key({ name: 'alt', ch: '2' });
  s.key(ch('1'));
  assert.ok(!log.some((l) => l.startsWith('canLeave')), 'a tab switch only deactivates');
  s.key({ name: 'alt', ch: '2' });
  ctx.navigate('home', { run: 'r1' });
  assert.deepEqual(log.slice(-2), ['canLeave form navigate', 'activate form'], 'asked, and shown when it says no');
  assert.match(s.text, /\[1 Home\][\s\S]*form body/, 'refused: the page stays and shows');
  ok = true;
  s.key({ name: 'alt', ch: '2' });
  ctx.navigate('home', { run: 'r1' });
  assert.match(s.text, /Home body/);
  assert.deepEqual(log.slice(-2), ['canLeave form navigate', 'dispose form'], 'a page that agrees at once is not woken up to be dropped');
  app.quit();
  await done;
});

test('quit asks every page (the showing tab first); asking to quit again while it waits quits; App.quit asks nobody', async () => {
  {
    const { s, ctx, done } = setup();
    const log: string[] = [];
    let ended = false;
    void done.then(() => { ended = true; });
    const pending = deferred();
    ctx.push(guarded('editor', log, () => pending.promise));
    s.key({ name: 'alt', ch: '2' });
    s.key(ch('q'));
    assert.deepEqual(log.slice(-2), ['canLeave editor quit', 'activate editor'], 'a page that asks is shown behind its question');
    pending.resolve(false);
    await sleep(0);
    assert.equal(ended, false, 'refused: still running');
    s.key(ch('q'));
    await sleep(0);
    assert.equal(ended, false, 'over a pushed page q is not a quit key (a stray letter never ends the app)');
    s.key(key('ctrl', 'd'));
    s.key(key('ctrl', 'd'));
    await done;
    assert.ok(log.includes('dispose editor'), 'a second request while the first waits ends the app; pages are disposed');
  }
  {
    const { ctx, app, done } = setup();
    const log: string[] = [];
    ctx.push(guarded('editor', log, () => false));
    app.quit();
    await done;
    assert.ok(!log.some((l) => l.startsWith('canLeave')), 'the program ending asks nobody');
    assert.deepEqual(log.slice(-2), ['deactivate editor', 'dispose editor']);
  }
});

test('app-wide commands are in the palette on every tab, after the page\'s own; one the page offers is listed once', async () => {
  const screens = fakeScreens(24, 100);
  const pages = [probe('home', 'Home', { log: [], keys: [], mice: [] }, { extra: { commands: () => [{ id: 'new', title: 'New goal', run: () => {} }] } }), probe('runs', 'Runs', { log: [], keys: [], mice: [] })];
  let saved = 0;
  const app = createApp({
    repoRoot: '/tmp/x', session: { ...session }, version: '1', config, pages, openScreen: screens.factory, icons: 'unicode', branch: () => 'main',
    commands: () => [{ id: 'goal', title: 'New goal', run: () => {} }, { id: 'save', title: 'Save settings to the repository…', run: () => { saved++; } }],
  });
  const done = app.run();
  screens.current.key(key('ctrl', 'p'));
  const home = screens.current.text;
  assert.equal(home.match(/New goal/g)?.length, 1, 'listed once, as the page\'s');
  assert.match(home, /App: Save settings to the repository/);
  screens.current.key(key('escape'));
  screens.current.key(ch('2'));
  screens.current.key(key('ctrl', 'p'));
  assert.match(screens.current.text, /App: New goal/);
  screens.current.type('save settings');
  screens.current.key(key('enter'));
  await sleep(0);
  assert.equal(saved, 1);
  app.quit();
  await done;
});

test('runPage hosts one page without tabs until it closes itself; canLeave and dispose apply', async () => {
  const { runPage } = await import('../src/app/index.ts');
  const screens = fakeScreens(24, 80);
  const log: string[] = [];
  let ctx: AppContext | undefined;
  let leave = false;
  const closed = runPage({
    repoRoot: '/tmp/my-repo', config, openScreen: screens.factory, icons: 'unicode',
    page: (c) => { ctx = c; return guarded('editor', log, () => leave, { title: 'Edit plan' }); },
  });
  let ended = false;
  void closed.then(() => { ended = true; });
  const s = screens.current;
  assert.match(s.text, /editor body/);
  assert.doesNotMatch(s.text, /\[1 /, 'no tab bar');
  assert.match(s.text.split('\n').at(-1)!, /Edit plan .*esc back/);
  s.key(key('ctrl', 'p'));
  assert.doesNotMatch(s.text, /Go to/);
  assert.match(s.text, /Close\s+esc/);
  s.key(key('escape'));
  s.key(ch('?'));
  assert.doesNotMatch(s.text, /switch tab/);
  s.key(key('escape'));
  s.key(ch('2'));
  ctx!.navigate('runs');
  assert.match(s.text, /No page called runs/);
  assert.match(s.text, /editor body/, 'navigating elsewhere changes nothing');
  s.key(key('escape'));
  await sleep(0);
  assert.equal(ended, false, 'the page said no');
  assert.deepEqual(log.slice(-1), ['canLeave editor back']);
  leave = true;
  ctx!.pop();
  await closed;
  assert.equal(s.closed, 1);
  assert.deepEqual(log.slice(-3), ['canLeave editor back', 'deactivate editor', 'dispose editor']);

  const quitting = runPage({ repoRoot: '/tmp/my-repo', config, openScreen: fakeScreens(24, 80).factory, icons: 'unicode', page: (c) => { ctx = c; return guarded('p', log); } });
  ctx!.quit();
  await quitting;
});

// ---- the terminal on loan, the spinner, and the lifecycle while the terminal is away ----

test('lend: a view left open stops drawing and listening when the loan ends; views may close in any order', async () => {
  const { screens, ctx, app, done } = setup();
  const mine = screens.current;
  let leaked: Screen | undefined;
  await ctx.lend(async (open) => { leaked = open!(); leaked.paint(['run view frame'], undefined); });
  assert.match(mine.text, /Home body/, 'the app painted itself back');
  leaked!.paint(['STALE RUN VIEW'], undefined);
  assert.doesNotMatch(mine.text, /STALE RUN VIEW/, 'a view that never closed cannot draw over the app');
  leaked!.onKey(() => { throw new Error('the old view got a key'); });
  mine.key(ch('2'));
  assert.match(mine.text, /\[2 Runs\]/, 'nor take its keys');

  const got: string[] = [];
  let aRepaints = 0;
  await ctx.lend(async (open) => {
    const a = open!();
    a.onKey((k) => got.push(`a:${k.name === 'char' ? k.ch : k.name}`));
    a.onResize(() => { aRepaints++; });
    const b = open!();
    b.onKey((k) => got.push(`b:${k.name === 'char' ? k.ch : k.name}`));
    mine.key(ch('1'));
    a.paint(['A under B'], undefined);
    assert.doesNotMatch(mine.text, /A under B/, 'only the newest view draws');
    b.close();
    assert.equal(aRepaints, 1, 'the view below is asked to repaint');
    mine.key(ch('2'));
    const c = open!();
    c.onKey((k) => got.push(`c:${k.name === 'char' ? k.ch : k.name}`));
    a.close();
    mine.key(ch('3'));
    c.close();
    mine.key(ch('4'));
  });
  assert.deepEqual(got, ['b:1', 'a:2', 'c:3'], 'an older view closing first leaves the newer one its keys');
  app.quit();
  await done;
});

test('busy: a question the work asks stays above the spinner and gets the keys; what was open before stays under it', async () => {
  const { s, ctx, app, done } = setup();
  const work = ctx.busy('Merging…', async () => { await sleep(10); return ctx.confirm({ title: 'Conflict', message: 'Abort the merge?' }); });
  await sleep(200);
  assert.match(s.text, /Abort the merge\?/, 'the question shows, not the spinner');
  s.key(key('right'));
  s.key(key('enter'));
  assert.equal(await work, true, 'and was answered');
  assert.doesNotMatch(s.text, /Merging|Abort the merge/);
  const first = ctx.confirm({ title: 'Before', message: 'Opened before the work' });
  const slow = ctx.busy('Slow work', () => sleep(250).then(() => 1));
  await sleep(160);
  assert.match(s.text, /Slow work/, 'the spinner covers what was already open');
  s.key(key('escape'));
  assert.equal(await slow, 1);
  assert.match(s.text, /Opened before the work/, 'the earlier dialog is back on top, unanswered');
  s.key(key('escape'));
  assert.equal(await first, false);
  app.quit();
  await done;
});

test('push, pop and navigate while the terminal is away: the page showing on the way back is activated once', async () => {
  const { p, ctx, app, done } = setup();
  const sub = guarded('sub', p.log);
  p.log.length = 0;
  await ctx.suspend(async () => { ctx.push(sub); });
  assert.deepEqual(p.log, ['deactivate home', 'activate sub']);
  p.log.length = 0;
  await ctx.lend(async () => { ctx.pop(); });
  assert.deepEqual(p.log, ['deactivate sub', 'canLeave sub back', 'dispose sub', 'activate home']);
  p.log.length = 0;
  await ctx.suspend(async () => { ctx.navigate('runs', { run: 'r9' }); });
  assert.deepEqual(p.log, ['deactivate home', 'activate runs {"run":"r9"}'], 'navigate\'s params arrive with the one activation');
  app.quit();
  await done;
});

test('a modal that fails to draw shows its error as plain text, never the escapes in it', async () => {
  const { s, ctx, app, done } = setup();
  void ctx.modal({ cancel: undefined, key: () => ({ value: undefined }), render: () => { throw new Error('cannot read "evil\x1b]0;PWNED\x07name\x1b[2J"\nsecond line'); } });
  assertFrame(s.lines, 24, 100, 'failed modal');
  assert.match(s.text, /cannot read "evilname" second line/);
  app.quit();
  await done;
});

// ---- keys in order on a real terminal ----

/** The app on openScreen over fake streams: `send` is one read from the terminal. */
function onTerminal(page: (ctx: AppContext) => Page) {
  const out = Object.assign(new EventEmitter(), { rows: 24, columns: 100, write: () => true });
  const inp = Object.assign(new EventEmitter(), { isRaw: false, setRawMode: (raw: boolean) => { inp.isRaw = raw; }, resume: () => {}, pause: () => {}, setEncoding: () => {} });
  let ctx!: AppContext;
  const app = createApp({
    repoRoot: '/tmp/my-repo', session: { ...session }, version: '1', config, icons: 'unicode', branch: () => 'main',
    pages: [(c) => { ctx = c; return page(c); }],
    openScreen: () => openScreen(out as unknown as NodeJS.WriteStream, inp as unknown as NodeJS.ReadStream, { escapeMs: 10 }),
  });
  const done = app.run();
  return { app, done, ctx, send: (data: string) => { inp.emit('data', data); } };
}
const settled = () => new Promise((r) => setTimeout(r, 40));

test('keys typed behind the Enter that closes a dialog wait for its answer to be applied: Ctrl-S saves the edit', async () => {
  let value = 'old';
  const saved: string[] = [];
  const t = onTerminal((ctx) => ({
    id: 'home', title: 'Home', render: () => ({ lines: [value] }), hints: () => [],
    onKey: (k) => {
      if (k.name === 'char' && k.ch === 'e') { void ctx.prompt({ title: 'Command' }).then((v) => { if (v !== undefined) value = v; }); return true; }
      if (k.name === 'ctrl' && k.ch === 's') { saved.push(value); return true; }
      return false;
    },
  }));
  t.send('e');
  t.send('echo ok\r\x13');   // typed ahead: the text, Enter and Ctrl-S arrive in one read
  await settled();
  assert.deepEqual(saved, ['echo ok']);
  t.app.quit();
  await t.done;
});

test('a held Escape, a paste and keys behind them arrive in the order they were typed', async () => {
  const seen: string[] = [];
  const t = onTerminal((ctx) => ({
    id: 'home', title: 'Home', render: () => ({ lines: ['x'] }), hints: () => [],
    onKey: (k) => {
      if (k.name === 'char' && k.ch === 'o') { void ctx.confirm({ title: 'Sure', message: 'Really?' }).then((v) => seen.push(`answer ${v}`)); return true; }
      seen.push(k.name === 'char' ? k.ch : k.name === 'paste' ? `paste ${k.text}` : k.name);
      return true;
    },
  }));
  t.send('o');
  t.send('y1\x1b');          // y answers the dialog; 1 comes behind it; ESC is held for the rest of a sequence
  await settled();
  t.send('\x1b[200~pasted\x1b[201~2');
  await settled();
  assert.deepEqual(seen, ['answer true', '1', 'escape', 'paste pasted', '2']);
  t.app.quit();
  await t.done;
});

// ---- settings that change the terminal, ASCII frames, key spelling ----

test('Icons and Mouse apply at once: ctx.g is refilled in place, the screen switches mouse reporting', async () => {
  let cfg = config();
  const screens = fakeScreens(24, 100);
  const mouse: boolean[] = [];
  const factory = () => { const sc = screens.factory(); sc.setMouse = (on) => { mouse.push(on); }; return sc; };
  let kept: AppContext['g'] | undefined;
  const page: PageFactory = (ctx) => {
    kept = ctx.g;
    return { id: 'home', title: 'Home', render: () => ({ lines: [`branch glyph ${ctx.g.branch} kept ${kept!.branch}`] }), onKey: () => false, hints: () => [{ key: 'enter', label: 'start' }] };
  };
  const app = createApp({ repoRoot: '/tmp/my-repo', session: { ...session }, version: '1', config: () => cfg, pages: [page], openScreen: factory, branch: () => 'main' });
  const done = app.run();
  const before = process.env.DULGER_ICONS;
  delete process.env.DULGER_ICONS;
  try {
    cfg = { ...cfg, tui: { ...cfg.tui, icons: 'unicode', mouse: true } };
    app.ctx.redraw();
    assert.match(screens.current.text, /branch glyph ⎇ kept ⎇/);
    cfg = { ...cfg, tui: { ...cfg.tui, icons: 'ascii', mouse: false } };
    // As the Settings page does: the change is in the session, so the next key press sees it.
    (app.ctx.session.overrides as Record<string, unknown>).tui = cfg.tui;
    screens.current.key(ch('x'));
    assert.match(screens.current.text, /branch glyph Y kept Y/, 'a glyph object kept from creation follows the setting too');
    assert.equal(mouse.at(-1), false, 'mouse reporting is switched off without a restart');
    assert.match(screens.current.lines.at(-1)!, /Enter start/, 'in ASCII the footer spells Enter out');
    for (const l of screens.current.lines) assert.match(l.replace(/\x1b\[[0-9;:]*m/g, ''), /^[\x20-\x7e]*$/, `an ASCII frame: ${JSON.stringify(l)}`);
    cfg = { ...cfg, tui: { ...cfg.tui, icons: 'unicode', mouse: true } };
    app.ctx.redraw();
    assert.equal(mouse.at(-1), true);
    assert.match(screens.current.lines.at(-1)!, /⏎ start/, 'one spelling for Enter in the footer: the glyph set\'s');
  } finally {
    if (before === undefined) delete process.env.DULGER_ICONS; else process.env.DULGER_ICONS = before;
  }
  app.quit();
  await done;
});

test('help spells Enter as the footer does', async () => {
  const { s, app, done } = setup({ extra: { help: () => [{ title: 'Home', keys: [{ key: 'enter', label: 'start the goal' }, { key: 'alt-enter', label: 'new line' }] }] } });
  s.key(ch('?'));
  assert.match(s.text, /⏎\s+start the goal/);
  assert.match(s.text, /alt-⏎\s+new line/);
  app.quit();
  await done;
});

test('the header reads the config again only when the session changed, on redraw and when the terminal comes back', async () => {
  let reads = 0;
  const screens = fakeScreens(24, 100);
  const sess = { ...session } as typeof session & { overrides: Record<string, unknown> };
  const app = createApp({ repoRoot: '/tmp/my-repo', session: sess, version: '1', icons: 'unicode', config: () => { reads++; return config(); }, pages: [probe('home', 'Home', { log: [], keys: [], mice: [] })], openScreen: screens.factory, branch: () => 'main' });
  const done = app.run();
  const before = reads;
  for (let i = 0; i < 20; i++) screens.current.key(ch('x'));
  assert.equal(reads, before, 'typing does not read the config');
  sess.overrides.concurrency = 7;
  screens.current.key(ch('x'));
  assert.ok(reads > before, 'a changed session does');
  const after = reads;
  app.ctx.redraw();
  assert.ok(reads > after, 'and so does a redraw');
  app.quit();
  await done;
});
