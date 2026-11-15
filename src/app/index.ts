// Entry points of the full-screen app: `runApp` is what `dulger` opens on a terminal (src/cli.ts), the
// tabbed app; `runPage` hosts one page on its own (no tabs), e.g. the plan editor opened from a live
// run, until the page closes itself or the person quits.
import type { Config } from '../config.ts';
import type { Session } from '../repl.ts';
import { CliError } from '../errors.ts';
import { sessionConfig } from '../replModels.ts';
import { openScreen, type Screen } from '../tui/screen.ts';
import type { IconSet } from '../tui/theme.ts';
import { appCommands } from './global.ts';
import { exitNote } from './pages/settings.data.ts';
import { PAGES } from './pages/index.ts';
import { createApp } from './shell.ts';
import type { PageFactory } from './types.ts';

export type { AppContext, LeaveReason, NavParams, Page, PageCommand, PageFactory } from './types.ts';
export { createApp, type App, type AppOptions } from './shell.ts';

/** Run the app on this terminal until the person quits. */
export async function runApp(repoRoot: string, session: Session, version: string): Promise<void> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) throw new CliError('the dulger app needs an interactive terminal');
  const config = () => sessionConfig(repoRoot, session);
  const app = createApp({
    // No fixed icon set: the app follows the Icons setting (DULGER_ICONS still wins), as it follows Mouse.
    repoRoot, session, version, config, pages: PAGES,
    commands: (ctx) => appCommands(ctx),
    // Read the mouse setting each time the terminal is taken back, so a changed setting applies.
    openScreen: () => openScreen(process.stdout, process.stdin, { mouse: safeMouse(config) }),
  });
  await app.run();
  // Quitting never asks about unsaved settings; what was changed in the app and not saved is said once,
  // on the normal terminal, so it is not lost silently.
  const note = exitNote(repoRoot, session, app.ctx.startSession as Session);
  if (note) process.stdout.write(`${note}\n`);
}

export interface RunPageOptions {
  repoRoot: string;
  /** The one page; it closes the host with `ctx.pop()` (Esc does the same) or `ctx.quit()`. */
  page: PageFactory;
  /** Default: an empty session. */
  session?: Session;
  /** Shown in the header (default: none). */
  version?: string;
  /** The effective configuration (default: `sessionConfig(repoRoot, session)`). */
  config?: () => Config;
  /** Tests: the screen to draw on (default: this terminal, which must be interactive) and the glyph set. */
  openScreen?: () => Screen;
  icons?: IconSet;
}

/**
 * Host one page full-screen, without tabs, until it closes itself (`ctx.pop()` on it, or `ctx.quit()`)
 * or the person quits. `canLeave` and `dispose` apply as in the app; `ctx.navigate` to another page is
 * a toast and nothing else.
 */
export async function runPage(o: RunPageOptions): Promise<void> {
  if (!o.openScreen && !(process.stdin.isTTY && process.stdout.isTTY)) throw new CliError('the dulger app needs an interactive terminal');
  const session: Session = o.session ?? { overrides: {}, yes: false, quiet: false, allowDirty: false };
  const config = o.config ?? (() => sessionConfig(o.repoRoot, session));
  const app = createApp({
    repoRoot: o.repoRoot, session, version: o.version ?? '', config, pages: [o.page], single: true,
    icons: o.icons,
    openScreen: o.openScreen ?? (() => openScreen(process.stdout, process.stdin, { mouse: safeMouse(config) })),
  });
  await app.run();
}

function safeMouse(config: () => { tui: { mouse?: boolean } }): boolean {
  try { return config().tui.mouse !== false; } catch { return true; }
}
