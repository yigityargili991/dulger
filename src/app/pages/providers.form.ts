// Adding or editing an API provider, as one form pushed over the Providers tab: name (fixed when
// editing), base URL, key variable, the key itself and the default model. Labels and values only:
// `?` says what the focused field is, and a disabled button says why when it is pressed. The key goes
// from a masked prompt straight into the user's keys file and is never kept, shown, logged or
// toasted; everything else is defined for the session only when the form is saved (^o, or the
// button; ^s is Providers' save, so it is not used here). Leaving with changes
// (Esc, Cancel, navigate, quit) asks first, through the shell's canLeave, listing what is lost; a key
// stored meanwhile stays stored, and leaving says so.
import { PROVIDER_DEFAULTS, type ApiConfig } from '../../config.ts';
import { keySource, keysFile } from '../../keys.ts';
import {
  KNOWN_PROVIDERS, KNOWN_PROVIDER_URLS, defaultKeyEnv, defineProvider, providerNameError, providerUrlError, storeProviderKey,
} from '../../replProviders.ts';
import { plainText } from '../../tui/text.ts';
import {
  compose, createForm, fieldHelp, fieldOf, focusKey, formCapturesText, formFields, formHeight, formHints, formKey, formMouse, formScroll, formWidth,
  inputValue, panel, renderForm, setSections,
  type FormEvent, type FormSection, type HelpGroup,
} from '../../tui/kit/index.ts';
import type { AppContext, LeaveReason, Page } from '../types.ts';
import { chooseModel, friendly, homePath, keyState, modelIdError, redactUrl, type ModelLister } from './models.shared.ts';

export interface ProviderFormOptions {
  /** A configured provider to edit, or the name an add starts with (a known name fills in its URL and key variable). */
  name?: string;
  lister: ModelLister;
  cache: Map<string, string[]>;
  /** Called with the name once the provider is defined, just before the form closes. */
  saved?(name: string): void;
}

interface Values { name: string; baseUrl: string; keyEnv: string; model: string }

const LABELS: Record<keyof Values, string> = { name: 'Name', baseUrl: 'Base URL', keyEnv: 'Key variable', model: 'Default model' };

/** A rule's message as a sentence: capitalised, ending in a full stop. */
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s);

export function keyEnvError(env: string): string | undefined {
  return env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)
    ? 'The key variable must be an environment variable name: letters, digits and _, not starting with a digit (e.g. GROQ_API_KEY).'
    : undefined;
}

/**
 * Ask for the key read from `env` with a masked prompt and hand it to `store`, which writes it to the
 * keys file and returns that file. The key is never shown, logged or toasted. True when one was stored.
 * The prompt states where it goes; `atOnce` (from the form) adds that it is kept even if the form is
 * then cancelled, and a variable set in the environment is flagged, since that one wins.
 */
export async function enterKey(ctx: AppContext, provider: string, env: string, store: (key: string) => string, o: { atOnce?: boolean } = {}): Promise<boolean> {
  const lines = [`${env} → ${homePath(keysFile())}`];
  if (o.atOnce) lines.push('stored at once');
  if (keySource(env) === 'environment') lines.push(`${ctx.g.warn} ${env} in the environment wins`);
  const key = await ctx.prompt({ title: `API key for ${provider}`, message: lines.join('\n'), secret: true, placeholder: 'paste the key' });
  if (key === undefined || !key.trim()) {
    ctx.toast('No key stored', 'warn');
    return false;
  }
  store(key);
  ctx.toast(`Key for ${provider} stored`, 'ok');
  return true;
}

export function createProviderFormPage(ctx: AppContext, o: ProviderFormOptions): Page {
  const g = ctx.g;
  const start = ctx.config().providers[o.name ?? ''];
  /** The configured provider being edited; undefined while adding. */
  let editing = start && o.name ? o.name : undefined;
  let values: Values = start
    ? { name: o.name!, baseUrl: redactUrl(start.baseUrl), keyEnv: start.apiKeyEnv ?? '', model: start.model ?? '' }
    : prefill(o.name && !providerNameError(o.name) ? o.name : '');
  const initial = { ...values };
  /** What the name filled in, so a later name only replaces values the person did not type. */
  let auto = { baseUrl: values.baseUrl, keyEnv: values.keyEnv };
  let done = false;
  /** A key stored from this form (it is written at once): leaving without saving says it stays. */
  let storedKey: { provider: string; env: string } | undefined;

  function prefill(name: string): Values {
    return { name, baseUrl: KNOWN_PROVIDER_URLS[name] ?? '', keyEnv: name ? defaultKeyEnv(name) ?? '' : '', model: '' };
  }

  const nameError = (v: string): string | undefined => (v.trim() ? (providerNameError(v.trim()) ? cap(providerNameError(v.trim())!) : undefined) : undefined);
  const urlError = (v: string): string | undefined => (v.trim() ? (providerUrlError(v.trim()) ? cap(providerUrlError(v.trim())!) : undefined) : undefined);

  function sections(): FormSection[] {
    const v = values;
    const env = v.keyEnv.trim();
    const key = keyState(env || undefined);
    const keys = homePath(keysFile());
    // Values only, in groups without titles; what each field is goes to help through its description.
    return [
      {
        fields: [
          editing
            ? { kind: 'info', key: 'name', label: 'Name', value: editing, tag: 'fixed' }
            : { kind: 'text', key: 'name', label: 'Name', value: v.name, placeholder: 'e.g. groq', validate: nameError,
              description: `The provider's name: letters, digits, - and _. A known name (${KNOWN_PROVIDERS.join(', ')}) fills in its URL and key variable; one already set up is edited instead.` },
          { kind: 'text', key: 'baseUrl', label: 'Base URL', value: v.baseUrl, placeholder: 'https://api.example.com/v1', validate: urlError,
            description: 'Any OpenAI-compatible endpoint: the part of the address before /chat/completions, usually ending in /v1.' },
          { kind: 'text', key: 'keyEnv', label: 'Key variable', value: v.keyEnv, placeholder: 'none', validate: keyEnvError,
            description: 'The environment variable the key is read from. Saving keeps this name, never the key. Empty for an endpoint called without a key, such as a local Ollama.' },
        ],
      },
      {
        fields: [
          // Without a key variable there is no key to have: the dash says it.
          { kind: 'info', key: 'keyState', label: 'Key', value: env ? key.short : '—', tone: key.tone },
          { kind: 'action', key: 'setKey', label: !env || key.missing ? 'Set key…' : 'Replace key…', disabled: env ? false : 'No key variable',
            description: `Typed masked and stored in ${keys} (mode 600) at once, even if the form is then cancelled: never in the repository, never shown again. It can be skipped and set later (s on Providers).` },
        ],
      },
      {
        fields: [
          { kind: 'text', key: 'model', label: 'Default model', value: v.model, placeholder: 'none',
            validate: (x) => (x.trim() ? modelIdError(x.trim()) : undefined),
            description: 'Used by roles on this provider when nothing else picks one; a role on it cannot run without a model. Enter on it while empty lists the endpoint\'s models.' },
          { kind: 'action', key: 'pickModel', label: 'List models…',
            description: 'Asks the endpoint for its models; that needs the URL and, when there is a key variable, the key.' },
        ],
      },
      {
        fields: [
          { kind: 'action', key: 'save', label: editing ? 'Save changes' : 'Add provider',
            description: 'Defines it for this session (^o). ^s on Providers or Settings then writes the endpoint and the key variable\'s name to your config file, never the key.' },
          { kind: 'action', key: 'cancel', label: 'Cancel', description: 'Closes the form; with changes, it asks first.' },
        ],
      },
    ];
  }

  // A disabled button says why only when it is pressed.
  const form = createForm(sections(), { focus: editing ? 'baseUrl' : 'name', onRefuse: (reason) => ctx.toast(plainText(reason), 'info') });

  /** Rebuild after `changed` values moved under the person; a field being typed into shows its new value. */
  function rebuild(changed: Array<keyof Values> = []): void {
    setSections(form, sections());
    const e = form.editing;
    if (e && (changed as string[]).includes(e.key) && inputValue(e.input) === e.original) focusKey(form, e.key);
  }

  /** The values with whatever is being typed into the focused field. */
  function current(): Values {
    const v = { ...values };
    const e = form.editing;
    if (e && (e.key === 'name' || e.key === 'baseUrl' || e.key === 'keyEnv' || e.key === 'model')) v[e.key] = inputValue(e.input);
    return v;
  }

  /** What leaving would lose: each value that differs from how the form opened, as it is now. */
  function lost(): Array<{ label: string; value: string }> {
    const v = current();
    return (Object.keys(LABELS) as Array<keyof Values>)
      .filter((k) => v[k] !== initial[k])
      .map((k) => ({ label: LABELS[k], value: initial[k] ? `${initial[k]} → ${v[k] || '—'}` : v[k] }));
  }

  const dirty = (): boolean => !done && lost().length > 0;

  /** The entry as typed so far, for listing models and storing a key before it is defined. */
  function draft(v: Values): ApiConfig {
    const base = editing ? ctx.config().providers[editing] : undefined;
    return { ...PROVIDER_DEFAULTS, ...base, baseUrl: v.baseUrl.trim(), apiKeyEnv: v.keyEnv.trim() || undefined, model: v.model.trim() || undefined };
  }

  function nameChanged(raw: string): void {
    const name = raw.trim();
    values.name = name;
    const existing = name && !providerNameError(name) ? ctx.config().providers[name] : undefined;
    if (existing) {
      // Already set up: edit that entry instead of defining a second one over it.
      editing = name;
      values = { name, baseUrl: redactUrl(existing.baseUrl), keyEnv: existing.apiKeyEnv ?? '', model: existing.model ?? '' };
      auto = { baseUrl: values.baseUrl, keyEnv: values.keyEnv };
      ctx.toast(`${name} exists: editing it`, 'info');
      rebuild(['baseUrl', 'keyEnv', 'model']);
      if (form.focus === 'name' || !fieldOf(form, form.focus ?? '')) focusKey(form, 'baseUrl');
      return;
    }
    const next = prefill(name);
    if (!values.baseUrl || values.baseUrl === auto.baseUrl) values.baseUrl = next.baseUrl;
    if (!values.keyEnv || values.keyEnv === auto.keyEnv) values.keyEnv = next.keyEnv;
    auto = { baseUrl: values.baseUrl, keyEnv: values.keyEnv };
    rebuild(['baseUrl', 'keyEnv']);
  }

  async function storeKey(): Promise<void> {
    const v = current();
    const env = v.keyEnv.trim();
    const name = v.name.trim() || 'this provider';
    if (!env) { ctx.toast('No key variable', 'info'); return; }
    const bad = keyEnvError(env);
    if (bad) { ctx.toast(bad, 'error'); return; }
    // The entry does not exist until the form is saved; the key goes in now so its models can be listed.
    if (await enterKey(ctx, name, env, (key) => storeProviderKey({ providers: { [name]: draft(v) } }, name, key), { atOnce: true })) storedKey = { provider: name, env };
    rebuild();
  }

  async function pickModel(): Promise<void> {
    const v = current();
    const name = v.name.trim();
    const choice = await chooseModel(ctx, {
      title: `Default model for ${name || 'this provider'}`, harness: name, provider: draft(v), current: v.model.trim() || undefined,
      lister: o.lister, cache: o.cache,
    });
    if (!choice || choice.auto) return;
    values.model = choice.model;
    rebuild(['model']);
    ctx.toast(`Model ${choice.model}`, 'ok');
  }

  function fail(key: string, message: string): void {
    focusKey(form, key);
    const f = fieldOf(form, key);
    if (f) f.error = message;
  }

  function save(): void {
    const v = current();
    const name = (editing ?? v.name).trim();
    const baseUrl = v.baseUrl.trim();
    const keyEnv = v.keyEnv.trim();
    const model = v.model.trim();
    if (!name) return fail('name', 'Give the provider a name.');
    if (!editing && providerNameError(name)) return fail('name', cap(providerNameError(name)!));
    if (!baseUrl) return fail('baseUrl', 'Enter the base URL.');
    if (providerUrlError(baseUrl)) return fail('baseUrl', cap(providerUrlError(baseUrl)!));
    if (keyEnvError(keyEnv)) return fail('keyEnv', keyEnvError(keyEnv)!);
    if (model && modelIdError(model)) return fail('model', modelIdError(model)!);
    const was = editing;
    const p = defineProvider(ctx.session, ctx.config(), name, { baseUrl, apiKeyEnv: keyEnv || undefined, model: model || undefined });
    done = true;
    // What it still lacks before a run, as state words after the outcome.
    const needs = [!p.model ? 'no model' : '', p.keySource === 'missing' ? 'no key' : ''].filter(Boolean);
    ctx.toast([`${was ? 'Updated' : 'Added'} ${name}`, ...needs].join(' · '), needs.length ? 'warn' : 'ok');
    o.saved?.(name);
    ctx.pop();
  }

  function canLeave(reason: LeaveReason): boolean | Promise<boolean> {
    if (!dirty()) return true;
    // The facts: what is lost, field by field.
    const items = lost();
    return ctx.confirm(reason === 'quit'
      ? { title: 'Quit with unsaved changes?', message: '', items, confirm: 'Quit', cancel: 'Keep editing', danger: true }
      : { title: 'Discard changes', message: '', items, confirm: 'Discard', cancel: 'Keep editing', danger: true });
  }

  async function perform(fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); } catch (e) { ctx.toast(friendly(e), 'error'); } finally { ctx.redraw(); }
  }

  function handle(r: FormEvent): void {
    if (r.type === 'change') {
      const value = String(r.value ?? '');
      if (r.key === 'name') nameChanged(value);
      else if (r.key === 'baseUrl' || r.key === 'model') { values[r.key] = value.trim(); }
      else if (r.key === 'keyEnv') { values.keyEnv = value.trim(); rebuild(); }
      return;
    }
    switch (r.key) {
      case 'setKey': void perform(storeKey); break;
      case 'pickModel': void perform(pickModel); break;
      case 'save': void perform(save); break;
      case 'cancel': ctx.pop(); break;
    }
  }

  return {
    id: 'provider-form',
    get title() { return editing ?? (values.name.trim() || 'New provider'); },
    render(size) {
      // As wide as the form needs (room for an address being typed), as tall as its rows; a refused
      // value's message is read whole, so the panel widens for it instead of cutting it.
      const erring = Boolean(form.invalid) || formFields(form).some((x) => x.error);
      const cols = Math.min(size.cols, Math.max(formWidth(form, g) + 4, erring ? 76 : 64));
      const rows = Math.min(size.rows, formHeight(form, Math.max(1, cols - 4), g, { titles: false }) + 2);
      const rect = { top: 0, left: 0, rows, cols };
      const block = panel(rect, { g, title: editing ? `Edit ${editing}` : 'New provider', focused: true, scroll: () => formScroll(form) },
        (inner) => renderForm(form, inner, g, { titles: false }));
      return compose(size, [{ rect, block }]);
    },
    onKey(k) {
      if (k.name === 'ctrl' && k.ch === 'o') { void perform(save); return true; }
      // ^s saves on Providers; here it would only define the provider for the session.
      if (k.name === 'ctrl' && k.ch === 's') { ctx.toast(`^o ${editing ? 'saves' : 'adds'} here`, 'info'); return true; }
      // Enter on an empty Default model asks the endpoint for its list, rather than moving on.
      if (k.name === 'enter' && form.editing?.key === 'model' && !inputValue(form.editing.input).trim()) { void perform(pickModel); return true; }
      const r = formKey(form, k);
      if (typeof r === 'object') { handle(r); return true; }
      if (r !== false) return true;
      // A letter on a row that takes no typing (a button, the key's status) does nothing: it must not
      // turn into a shortcut or a quit while the person thinks they are typing into the form.
      if ((k.name === 'char' && k.ch !== '?' && k.ch !== ':') || k.name === 'paste') {
        return true;
      }
      // Esc that the form does not use (nothing to revert) is the shell's back, which asks canLeave.
      return false;
    },
    onMouse(m) {
      const r = formMouse(form, { ...m, row: m.row - 1, col: m.col - 2 });
      if (typeof r === 'object') handle(r);
      return r !== false;
    },
    hints: () => [...formHints(form).slice(0, 3), { key: '^o', label: editing ? 'save' : 'add' }],
    help: (): HelpGroup[] => {
      const focused = fieldHelp(form);
      return [
        ...(focused ? [focused] : []),
        { title: 'Provider form', keys: [
          { key: '↑↓  tab', label: 'move between fields' },
          { key: 'enter', label: 'next field, or press a button' },
          { key: 'enter', label: 'on an empty Default model: list the endpoint\'s models' },
          { key: 'esc', label: 'revert the field, then cancel the form' },
          { key: '^o', label: editing ? 'save the changes for this session' : 'add the provider for this session' },
        ] },
        { title: 'About', keys: [], text: [
          `A key is stored at once in ${homePath(keysFile())} (mode 600), even if the form is cancelled: never in the repository, never shown again.`,
          'The form defines the provider for this session; ^s on Providers or Settings saves it to your config file.',
        ] },
      ];
    },
    capturesText: () => formCapturesText(form),
    canLeave,
    dispose() {
      if (!done && storedKey) ctx.toast(`${storedKey.env} stays stored`, 'info');
    },
  };
}
