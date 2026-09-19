import { CliError } from './errors.ts';
import type { Board } from './types.ts';
import { harnessNames, type Config } from './config.ts';
import { validateBoard, saveBoard, appendEvent } from './board/store.ts';
import { select, type SelectOptions, type Selection } from './tui/select.ts';
import { ask } from './ui/prompt.ts';

interface EditorIO { select(o: SelectOptions): Promise<Selection>; ask(text: string): Promise<string | undefined> }
export function validatePlanDraft(board: Board, config: Config): void {
  validateBoard(board);
  if (!board.cards.length) throw new CliError('The plan needs at least one card.');
  for (const card of board.cards) {
    if (!card.title.trim() || !card.description.trim() || card.tasks.some((t) => !t.instructions.trim())) throw new CliError(`${card.id}: title, description and task instructions cannot be empty.`);
    if (card.worker?.harness && !harnessNames(config).includes(card.worker.harness)) throw new CliError(`${card.id}: choose a configured worker harness.`);
    if (card.worker?.model && /[\s\p{Cc}]/u.test(card.worker.model)) throw new CliError(`${card.id}: model IDs cannot contain spaces or control characters.`);
  }
}
export async function editPlan(root: string, board: Board, config: Config, io: EditorIO = { select, ask }): Promise<boolean> {
  if (board.cards.some((c) => c.status !== 'backlog' || c.tasks.some((t) => t.attempts > 0))) throw new CliError('Only an unstarted plan can be edited. Add instructions or retry a card after execution starts.');
  const draft = structuredClone(board);
  let message = 'Edit the plan before dispatch. Save applies all edits; Escape discards them.';
  for (;;) {
    const choice = await io.select({ title: 'Edit plan', description: message, choices: [
      ...draft.cards.map((c) => ({ value: c.id, label: `${c.id} ${c.title}`, description: `${c.tasks.length} tasks · after ${c.dependsOn.join(', ') || 'nothing'} · ${c.worker?.model ?? 'routed worker model'}` })),
      { value: ':save', label: 'Save plan edits' },
    ] });
    if (choice == null) return false;
    if (choice === ':save') {
      try { validatePlanDraft(draft, config); } catch (e) { message = (e as Error).message; continue; }
      board.cards = draft.cards;
      saveBoard(root, board);
      appendEvent(root, board.runId, { type: 'plan_edited' });
      return true;
    }
    const card = draft.cards.find((c) => c.id === choice)!;
    const field = await io.select({ title: `Edit ${card.id}`, description: 'Blank input keeps the current value. Use - to clear an optional field. Separate list items with |.', choices: [
      { value: 'title', label: 'Title', description: card.title },
      { value: 'description', label: 'Description', description: card.description },
      { value: 'acceptanceCriteria', label: 'Acceptance criteria', description: card.acceptanceCriteria.join(' | ') },
      { value: 'dependsOn', label: 'Dependencies', description: card.dependsOn.join(' | ') },
      { value: 'verify', label: 'Verification commands', description: 'Edit commands individually; shell pipes remain intact.' },
      { value: 'worker', label: 'Worker harness and model', description: 'A pinned model overrides task difficulty and retries.' },
      ...card.tasks.map((t) => ({ value: `task:${t.id}`, label: `Task ${t.id}: ${t.title}`, description: t.instructions })),
    ] });
    if (field === null) return false;
    if (!field) continue;
    if (field === 'worker') {
      const harness = await io.select({ title: `Worker for ${card.id}`, choices: [{ value: ':default', label: 'Use session settings' }, ...harnessNames(config).map((h) => ({ value: h, label: h }))] });
      if (harness === null) return false;
      if (!harness) continue;
      if (harness === ':default') { card.worker = undefined; continue; }
      const model = await io.ask('Model ID (blank = automatic tiers / harness default): ');
      if (model !== undefined) card.worker = { harness, model: model.trim() || undefined };
    } else if (field === 'verify') {
      const idx = await io.select({ title: `Verification for ${card.id}`, choices: [...card.verify.map((command, i) => ({ value: String(i), label: command })), { value: ':add', label: 'Add verification command' }] });
      if (idx === null) return false;
      if (!idx) continue;
      const value = await io.ask(`${idx === ':add' ? 'New command' : card.verify[Number(idx)]} (blank keeps; - removes): `);
      if (!value?.trim()) continue;
      if (idx === ':add') { if (value.trim() !== '-') card.verify.push(value.trim()); }
      else if (value.trim() === '-') card.verify.splice(Number(idx), 1);
      else card.verify[Number(idx)] = value.trim();
    } else {
      const task = field.startsWith('task:') ? card.tasks.find((t) => t.id === field.slice(5)) : undefined;
      const current = task ? task.instructions : card[field as 'title' | 'description' | 'dependsOn' | 'acceptanceCriteria'];
      const value = await io.ask(`${field} [${Array.isArray(current) ? current.join(' | ') : current}]: `);
      if (!value?.trim()) continue;
      if (task) task.instructions = value.trim();
      else if (field === 'title' || field === 'description') card[field] = value.trim();
      else if (field === 'dependsOn' || field === 'acceptanceCriteria') card[field] = value.trim() === '-' ? [] : value.split('|').map((s) => s.trim()).filter(Boolean);
    }
  }
}
