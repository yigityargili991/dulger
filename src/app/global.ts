// What the palette offers on every tab, whatever page shows: start a new goal, check readiness, save
// the settings, and the line prompt. The shell stays generic; the app entry hands
// these to it (AppOptions.commands).
import { repl, type Session } from '../repl.ts';
import { saveSettings } from './pages/settings.flows.ts';
import type { AppContext, PageCommand } from './types.ts';

export interface AppCommandOptions {
  /** The line prompt, run nested in this session (default: repl). */
  linePrompt?: (repoRoot: string, session: Session, version: string, o: { nested: boolean }) => Promise<void>;
}

export function appCommands(ctx: AppContext, o: AppCommandOptions = {}): PageCommand[] {
  const linePrompt = o.linePrompt ?? ((root, session, version, opts) => repl(root, session, version, opts));
  return [
    { id: 'goal', title: 'New goal', description: 'Type a goal on Home: it is planned and waits for your go at the plan.', run: () => ctx.navigate('home') },
    { id: 'doctor', title: 'Check readiness', description: 'Git, backends, keys and the sandbox, without a model call (Doctor).', run: () => ctx.navigate('doctor') },
    { id: 'save', title: 'Save settings…', description: 'Shows what this session changed and where it goes, then writes it.', run: () => saveSettings(ctx) },
    {
      id: 'line', title: 'Open the line prompt', description: 'The line-by-line prompt in this session; quitting it comes back here.',
      run: async () => {
        try {
          await ctx.suspend(() => linePrompt(ctx.repoRoot, ctx.session, ctx.version, { nested: true }));
          ctx.toast('Back from the line prompt.', 'info');
        } catch (e) {
          ctx.toast(`The line prompt stopped: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      },
    },
  ];
}
