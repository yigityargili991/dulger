// What the Doctor shows for each readiness check from preflight (src/preflight.ts): a title, the detail
// with the line prompt's commands rephrased, and the page that fixes it. preflight's labels are the
// only key it gives, so they are matched here; a label this file does not know is shown as it is,
// with no action.
import type { Config } from '../../config.ts';
import { harnessNames, roleConfig } from '../../config.ts';
import type { PreflightCheck } from '../../preflight.ts';
import type { AgentRole } from '../../types.ts';
import type { NavParams } from '../types.ts';
import { ROLE_NOUNS } from '../look.ts';

export interface CheckAction {
  /** Button text, e.g. "Add a key for groq on Providers". */
  title: string;
  page: 'settings' | 'models' | 'providers';
  params?: NavParams;
}

export interface DoctorCheck {
  label: string;
  status: PreflightCheck['status'];
  detail: string;
  /** A word or two for the list row beside the label: `main`, `no key`, `off`, a version. */
  value?: string;
  action?: CheckAction;
}

const ROLES = Object.keys(ROLE_NOUNS) as AgentRole[];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One preflight check as the Doctor shows it. `config` is the effective config the checks ran on;
 * `allowDirty`: for checks made without the session's switch (preflight now passes an allowed dirty tree).
 * The detail and the action are what Home's blockers use too; `value` is only for the Doctor's list.
 */
export function describeCheck(check: PreflightCheck, config: Config, o: { allowDirty?: boolean } = {}): DoctorCheck {
  const shown = describe(check, config, o);
  const value = safe(() => checkValue(check, shown, config), undefined);
  return value ? { ...shown, value } : shown;
}

/** The short value of a check, from what preflight said; none for a label this file does not know. */
function checkValue(check: PreflightCheck, shown: DoctorCheck, config: Config): string | undefined {
  const { label, detail } = check;
  const ok = shown.status === 'pass';
  const harnesses = harnessNames(config);
  if (/^(planner|worker|checker|docs|reporter) model$/.test(label)) return ok ? undefined : 'none';
  if (/^(planner|worker|checker|docs|reporter) budget$/.test(label)) return ok ? undefined : 'unsupported';
  if (/ credentials$/.test(label)) return ok ? 'key set' : 'no key';
  if (/ spend$/.test(label)) return 'tokens only';
  if (harnesses.includes(label)) {
    if (!ok) return 'not found';
    const first = detail.split(';')[0]!.trim();
    return /\d+\.\d+[\w.+-]*/.exec(first)?.[0] ?? (first.length <= 16 ? first : undefined);
  }
  switch (label) {
    case 'Git repository': return ok ? /^Branch (\S+)/.exec(detail)?.[1] : /dulger init/.test(detail) ? 'no commits' : undefined;
    case 'Git identity': return ok ? undefined : 'not set';
    case 'Working tree': return ok ? 'dirty · allowed' : 'dirty';
    case 'Worktree directory': return ok ? 'writable' : 'not writable';
    case 'Settings': return ok ? undefined : 'invalid';
    case 'Progress reporter': return 'skipped';
    case 'Worktree setup': return detail.replace(/^Will run in each new worktree:\s*/, '').trim() || undefined;
    case 'Sandbox': {
      const mode = /^(off|auto|required)\b/.exec(detail)?.[1];
      return mode && (ok || mode === 'off' ? mode : `${mode} · broken`);
    }
    case 'Repository sandbox key': return 'ignored';
    default: return undefined;
  }
}

function describe(check: PreflightCheck, config: Config, o: { allowDirty?: boolean }): DoctorCheck {
  const { label, status, detail } = check;
  const plain = { label, status, detail };
  const harnesses = safe(() => harnessNames(config), [] as string[]);

  const roleWord = /^(planner|worker|checker|docs|reporter) (model|budget)$/.exec(label);
  if (roleWord && ROLES.includes(roleWord[1] as AgentRole)) {
    const role = roleWord[1] as AgentRole;
    const name = ROLE_NOUNS[role];
    const harness = safe(() => roleConfig(config, role).harness, '');
    const on = harness ? ` on ${harness}` : '';
    if (roleWord[2] === 'model') {
      return { label: `${cap(name)} model`, status,
        detail: status === 'pass' ? detail : `The ${name} runs${on}, which has no model of its own. Choose one for the ${name} on the Models tab.`,
        action: { title: `Choose the ${name}'s model`, page: 'models', params: { role } } };
    }
    return { label: `${cap(name)} budget`, status,
      detail: status === 'pass' ? detail : `The ${name} runs${on}, which reports tokens but not dollars, so its dollar budget cannot be enforced. Remove the budget or move the ${name} to another backend on the Models tab.`,
      action: { title: `Change the ${name} on Models`, page: 'models', params: { role } } };
  }

  if (label === 'Progress reporter') {
    const harness = safe(() => roleConfig(config, 'reporter').harness, '');
    return { label, status,
      detail: `${harness || 'This backend'} cannot run the progress reporter without tools, so progress notes are skipped. Give the progress reporter a Claude Code or API backend on the Models tab, or turn Progress notes off in Settings.`,
      action: { title: 'Choose the progress reporter\'s backend', page: 'models', params: { role: 'reporter' } } };
  }

  const credentials = / credentials$/.exec(label);
  if (credentials) {
    const provider = label.slice(0, credentials.index);
    if (provider && harnesses.includes(provider)) {
      const env = config.providers[provider]?.apiKeyEnv;
      if (status === 'pass') return { label, status, detail, action: { title: `Open ${provider} on Providers`, page: 'providers', params: { provider } } };
      return { label, status,
        detail: `No API key for ${provider}. Add one on the Providers tab, where it is kept in your user keys file${env ? `, or set ${env} in the environment dulger starts from` : ''}.`,
        action: { title: `Add a key for ${provider}`, page: 'providers', params: { provider, add: true } } };
    }
  }

  const spend = / spend$/.exec(label);
  if (spend && harnesses.includes(label.slice(0, spend.index))) {
    const harness = label.slice(0, spend.index);
    return { label, status,
      detail: `${harness} reports tokens but not dollars, so the run and card budgets cannot count what it spends. Tokens are still recorded.`,
      action: { title: 'Review the budgets in Settings', page: 'settings', params: { key: 'budget' } } };
  }

  // A backend's own command-line tool: its label is the harness name.
  if (harnesses.includes(label)) {
    return { label: `${label} command`, status, detail,
      action: status === 'error' ? { title: 'Choose another backend in Settings', page: 'settings', params: { key: 'harness' } } : undefined };
  }

  switch (label) {
    case 'Git repository':
      return status === 'error' && /dulger init/.test(detail)
        ? { ...plain, detail: 'The repository has no commits yet, and agents start their work from a commit. Make a first commit, then check again.' }
        : plain;
    case 'Git identity':
      return status === 'error'
        ? { ...plain, detail: `Git has no name and email to commit with. Set user.name and user.email in your Git config, then check again. Git said: ${detail}` }
        : plain;
    case 'Working tree': {
      // preflight passes a dirty tree the session allows; older callers only say so through `allowDirty`.
      const allowed = status === 'pass' || o.allowDirty;
      // The app does not start a run on a dirty tree unless the session allows it (Home says so too),
      // so here that is an error, not a note: the Doctor and Home agree on whether a run can start.
      return { ...plain, status: allowed ? 'pass' : 'error',
        detail: allowed
          ? 'There are uncommitted edits. Allow uncommitted changes is on for this session, so a run starts anyway: from the last commit, so the edits are not part of the agents\' work.'
          : 'There are uncommitted edits, so a run cannot start: a run starts from the last commit, and the agents would not see them. Commit them, or turn on Allow uncommitted changes for this session.',
        action: { title: 'Allow uncommitted changes in Settings', page: 'settings', params: { key: 'dirty' } } };
    }
    case 'Worktree setup': {
      const command = detail.replace(/^Will run in each new worktree:\s*/, '');
      return { ...plain,
        detail: `The repository's settings (.dulger/config.json, "worktreeSetup") name a setup command that runs as a shell command in every new worktree, before that card's agents start: ${command}. It is listed so that you know it runs on every card, confined only when the sandbox is on. Nothing needs fixing if it is the command you expect; otherwise change it in that file.` };
    }
    case 'Settings':
      return status === 'pass' ? plain : { ...plain, action: { title: 'Open Settings', page: 'settings' } };
    case 'Sandbox':
      return { ...plain, detail: sandboxDetail(detail), action: { title: 'Change the sandbox in Settings', page: 'settings', params: { key: 'sandbox' } } };
    case 'Repository sandbox key':
      return { ...plain,
        detail: 'The repository\'s .dulger/config.json sets a sandbox mode, and it is ignored: the sandbox confines code from the repository, so only your own dulger config, the command line and this session choose it.',
        action: { title: 'Change the sandbox in Settings', page: 'settings', params: { key: 'sandbox' } } };
    default:
      return plain;
  }
}

/** The sandbox detail without its instructions for the config file and the command line: the action changes it here. */
function sandboxDetail(detail: string): string {
  const at = detail.indexOf(' Set "sandbox"');
  if (at < 0) return detail;
  const link = /https?:\/\/\S+#sandbox/.exec(detail.slice(at))?.[0];
  return `${detail.slice(0, at)} Choose auto or required in Settings to confine Claude Code agents and those commands for this session; your own dulger config sets the default.${link ? ` What it does and does not confine: ${link}` : ''}`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export interface DoctorSummary { pass: number; warning: number; error: number; canRun: boolean }

export function summarize(checks: readonly { status: PreflightCheck['status'] }[]): DoctorSummary {
  const n = (s: PreflightCheck['status']) => checks.filter((c) => c.status === s).length;
  return { pass: n('pass'), warning: n('warning'), error: n('error'), canRun: n('error') === 0 };
}
