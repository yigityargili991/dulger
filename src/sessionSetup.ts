import { readProfiles, saveProfile, applyProfile } from './profiles.ts';
import { preflight, preflightText } from './preflight.ts';
import { pager } from './tui/pager.ts';
import { capabilities } from './adapters/capabilities.ts';
import { getAdapter } from './adapters/index.ts';
// A draft session: nothing is applied until Start, and nothing is written to repository config.
import { harnessNames, roleConfig, type Config, type RoleConfig } from './config.ts';
import { MODEL_ALIASES, MODEL_ROLES, sessionConfig } from './replModels.ts';
import { listModels } from './adapters/models.ts';
import { keySource } from './keys.ts';
import { ask } from './ui/prompt.ts';
import { plainText } from './tui/text.ts';
import { select, type Choice, type SelectOptions, type Selection } from './tui/select.ts';
import type { Session } from './repl.ts';
import type { AgentRole, ModelTier } from './types.ts';

export interface SetupPrompts {
  select(options: SelectOptions): Promise<Selection>;
  ask(question: string): Promise<string | undefined>;
  models: typeof listModels;
  say(message: string): void;
}
const terminal: SetupPrompts = { select, ask, models: listModels, say: (message) => console.log(plainText(message)) };
const SETS: Choice[] = [
  { value: 'auto', label: 'Automatic tiers', description: 'Planner and reviewer use high; workers follow task difficulty and escalate on retries; docs and reporter use low.' },
  { value: 'balanced', label: 'Balanced set', description: 'Pin workers to medium, planner and reviewer to high, docs and reporter to low. Ignores task difficulty.' },
  { value: 'low', label: 'Low tier for every role', description: 'Pin every role to the configured low-tier model. Ignores task difficulty and retry escalation.' },
  { value: 'high', label: 'High tier for every role', description: 'Pin every role to the configured high-tier model. Ignores task difficulty and retry escalation.' },
];

/** Apply a complete set, explicitly replacing old backend and model pins. */
export function applyModelSet(draft: Session, config: Config, harness: string, set: string): void {
  draft.overrides.harness = harness;
  draft.overrides.routing = { ...config.routing, enabled: set === 'auto' };
  draft.model = undefined;
  draft.modelRoles = {};
  for (const role of MODEL_ROLES) {
    const tier: ModelTier = set === 'balanced' ? (role === 'worker' ? 'medium' : role === 'planner' || role === 'checker' ? 'high' : 'low') : set === 'high' ? 'high' : 'low';
    const model = set === 'auto' ? undefined : config.routing.models[harness]?.[tier] ?? config.providers[harness]?.model;
    draft.modelRoles[role] = { harness, model };
  }
}

export function setupIssues(config: Config): string[] {
  const issues: string[] = [];
  for (const role of MODEL_ROLES) {
    if ((role === 'docs' && !config.docs) || (role === 'reporter' && config.progressIntervalSec <= 0)) continue;
    const rc = roleConfig(config, role);
    if (config.providers[rc.harness] && !rc.model) issues.push(`${role} on ${rc.harness} needs a model; choose one for all roles or edit that role.`);
  }
  return issues;
}

function roleLabel(config: Config, role: AgentRole): string {
  const rc = roleConfig(config, role);
  const model = rc.model ?? (config.providers[rc.harness] ? 'model required' : 'harness default');
  const disabled = (role === 'docs' && !config.docs) || (role === 'reporter' && config.progressIntervalSec <= 0);
  const suffix = disabled ? ' [off]' : role === 'reporter' && !capabilities(getAdapter(rc.harness, config)).toolFree ? ' [skipped: no tool-free mode]' : !config.roles[role]?.model && config.routing.enabled ? ' [auto]' : '';
  return `${role.padEnd(8)} ${rc.harness} / ${model}${suffix}`;
}

function harnessChoices(config: Config): Choice[] {
  return harnessNames(config).map((name) => ({ value: name, label: name,
    description: name === 'fake' ? 'Local demo; no model calls.' : name === 'claude' ? 'Claude Code CLI.' : name === 'codex' ? 'Codex CLI. Progress reporting needs a separate Claude/API role.' : config.providers[name]!.baseUrl }));
}

/** Returns false on cancel. Existing flags and repository settings are the initial draft. */
export async function setupSession(repoRoot: string, session: Session, io: SetupPrompts = terminal): Promise<boolean> {
  const original = structuredClone(session);
  let draft = structuredClone(session);
  let setLabel = 'Current settings';
  let selected = 'start';
  let message = 'Choose your harness and models before entering a goal. Changes apply only when you start.';
  const modelCache = new Map<string, string[]>();

  async function chooseModel(config: Config, harness: string, current?: string): Promise<Selection> {
    const provider = config.providers[harness];
    let note = 'Pick a configured model or enter an exact model ID.';
    if (provider && !modelCache.has(harness)) {
      if (provider.apiKeyEnv && keySource(provider.apiKeyEnv) === 'missing') {
        note = `Set ${provider.apiKeyEnv} with /provider after setup to load remote models. You can enter a model ID now.`;
      } else {
        io.say(`Loading models from ${harness}…`);
        try { modelCache.set(harness, await io.models(provider)); }
        catch (err) { note = `Could not load models: ${(err as Error).message}. Configured models and custom IDs are still available.`; }
      }
    }
    const models = [...new Set([
      ...(current ? [current] : []), ...Object.values(config.routing.models[harness] ?? {}),
      ...MODEL_ALIASES.filter((a) => a.harness === harness).map((a) => a.model),
      ...(provider?.model ? [provider.model] : []), ...(modelCache.get(harness) ?? []),
    ])];
    const picked = await io.select({ title: `Model for ${harness}`, description: note, selected: current ? `model:${current}` : undefined,
      choices: [...models.map((model) => ({ value: `model:${model}`, label: model })), { value: 'custom', label: 'Enter a model ID…', description: 'Use a model supported by this harness or provider.' }] });
    if (picked === null || picked === undefined) return picked;
    if (picked !== 'custom') return picked.slice('model:'.length);
    for (;;) {
      const text = await io.ask(`Model ID${current ? ` [${plainText(current)}]` : ''}: `);
      if (text === undefined) return undefined;
      const model = text.trim() || current;
      if (model && !/[\s\p{Cc}]/u.test(model)) return model;
      io.say('Enter a non-empty model ID without spaces.');
    }
  }

  for (;;) {
    const config = sessionConfig(repoRoot, draft);
    const choice = await io.select({ title: 'Session setup', description: message, selected, backLabel: 'cancel', choices: [
      { value: 'start', label: 'Start session', description: 'Use the choices below. No agents run until you enter a goal. Save later with /config save.' },
      { value: 'profile', label: 'Load saved profile', description: 'Apply a named harness, model, concurrency and budget configuration.' },
      { value: 'save-profile', label: 'Save these settings as a profile', description: 'Writes a named profile immediately; repository defaults stay unchanged.' },
      { value: 'limits', label: `Concurrency ${config.concurrency} · Run budget ${config.budgetUsd === undefined ? 'off' : '$' + config.budgetUsd}`, description: 'Set parallel cards and run/card dollar limits. Token-only harnesses cannot enforce dollar limits.' },
      { value: 'doctor', label: 'Check readiness', description: 'Check harness executables, credentials, Git and worktree prerequisites without a model call.' },
      { value: 'harness', label: `Harness       ${config.harness}`, description: 'Choose the harness for all roles. Changing it resets role model overrides to automatic tiers.' },
      { value: 'set', label: `Model set     ${setLabel}`, description: 'Automatic follows planner task difficulty. A pinned worker model overrides it, including retries.' },
      { value: 'model', label: 'Choose one model for all roles…', description: `Pin every role on ${config.harness} to the model you choose.` },
      ...MODEL_ROLES.map((role) => ({ value: `role:${role}`, label: roleLabel(config, role), description: `Override ${role}'s harness and model, or let its harness route automatically.` })),
      { value: 'restore', label: 'Restore starting settings', description: 'Restore the repository and CLI settings you opened setup with.' },
    ] });
    if (choice === null || choice === undefined) return false;
    selected = choice;
    message = 'Session only; /config save persists your choices after starting.';
    if (choice === 'start') {
      const issues = setupIssues(config);
      if (issues.length) { message = issues[0]!; continue; }
      Object.assign(session, draft);
      return true;
    }
    if (choice === 'profile') {
      try {
        const profiles = readProfiles(repoRoot);
        if (!Object.keys(profiles).length) { message = 'No saved profiles. Choose Save these settings as a profile.'; continue; }
        const name = await io.select({ title: 'Load profile', choices: Object.entries(profiles).map(([name, p]) => ({ value: name, label: name, description: `${p.config.harness} · ${p.config.concurrency} parallel cards` })) });
        if (name === null) return false;
        if (name) { applyProfile(draft, profiles[name]!); setLabel = `Profile: ${name}`; }
      } catch (e) { message = (e as Error).message; }
      continue;
    }
    if (choice === 'save-profile') {
      const name = await io.ask('Profile name: ');
      if (!name?.trim()) continue;
      try {
        let overwrite = false;
        if (Object.hasOwn(readProfiles(repoRoot), name.trim())) {
          overwrite = await io.select({ title: `Replace profile ${name.trim()}?`, choices: [{ value: 'back', label: 'Keep existing profile' }, { value: 'replace', label: 'Replace profile' }] }) === 'replace';
          if (!overwrite) continue;
        }
        saveProfile(repoRoot, name.trim(), config, overwrite);
        message = `Saved profile ${name.trim()}.`;
      } catch (e) { message = (e as Error).message; }
      continue;
    }
    if (choice === 'doctor') { await pager('Readiness checks', preflightText(preflight(repoRoot, config))); continue; }
    if (choice === 'limits') {
      const key = await io.select({ title: 'Execution limits', choices: [{ value: 'concurrency', label: 'Parallel cards' }, { value: 'budgetUsd', label: 'Run budget (USD)' }, { value: 'cardBudgetUsd', label: 'Card budget (USD)' }] });
      if (key === null) return false;
      if (!key) continue;
      const value = await io.ask(`${key} (blank keeps current${key === 'concurrency' ? '' : ', off removes limit'}): `);
      if (!value?.trim()) continue;
      if (value.trim() === 'off' && key !== 'concurrency') { draft.overrides[key as 'budgetUsd' | 'cardBudgetUsd'] = undefined; continue; }
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || (key === 'concurrency' && !Number.isInteger(n))) { message = 'Enter a positive number; parallel cards must be a whole number.'; continue; }
      draft.overrides[key as 'concurrency' | 'budgetUsd' | 'cardBudgetUsd'] = n;
      continue;
    }
    if (choice === 'restore') { draft = structuredClone(original); setLabel = 'Current settings'; continue; }
    if (choice === 'harness') {
      const harness = await io.select({ title: 'Harness for all roles', description: 'Changing the harness resets role overrides to automatic tiers.', choices: harnessChoices(config), selected: config.harness });
      if (harness === null) return false;
      if (harness && harness !== config.harness) { applyModelSet(draft, config, harness, 'auto'); setLabel = 'Automatic tiers'; }
    } else if (choice === 'set') {
      const set = await io.select({ title: 'Model set', description: `Use the configured model tiers for ${config.harness}. Per-role overrides can be edited afterwards.`, choices: SETS, selected: SETS.find((s) => s.label === setLabel)?.value });
      if (set === null) return false;
      if (set) { applyModelSet(draft, config, config.harness, set); setLabel = SETS.find((s) => s.value === set)!.label; }
    } else if (choice === 'model') {
      const model = await chooseModel(config, config.harness, roleConfig(config, 'worker').model);
      if (model === null) return false;
      if (model) {
        applyModelSet(draft, config, config.harness, 'auto');
        for (const role of MODEL_ROLES) draft.modelRoles![role] = { harness: config.harness, model };
        setLabel = 'One model for all roles';
      }
    } else if (choice.startsWith('role:')) {
      const role = choice.slice(5) as AgentRole;
      const current = roleConfig(config, role);
      const harness = await io.select({ title: `Harness for ${role}`, choices: harnessChoices(config), selected: current.harness });
      if (harness === null) return false;
      if (!harness) continue;
      const mode = await io.select({ title: `Model for ${role}`, description: 'Automatic follows this harness’s routing settings. A pinned model takes precedence over task difficulty.', selected: config.roles[role]?.model ? 'pin' : 'auto', choices: [
        { value: 'auto', label: config.routing.enabled ? 'Automatic tiers / harness default' : 'Harness default (routing is off)' }, { value: 'pin', label: 'Choose a model…' },
      ] });
      if (mode === null) return false;
      if (!mode) continue;
      let model: string | undefined;
      if (mode === 'pin') {
        const picked = await chooseModel(config, harness, harness === current.harness ? current.model : undefined);
        if (picked === null) return false;
        if (picked === undefined) continue;
        model = picked;
      }
      const rc: RoleConfig = { harness, model };
      draft.modelRoles = { ...draft.modelRoles, [role]: rc };
      setLabel = 'Custom roles';
    }
  }
}
