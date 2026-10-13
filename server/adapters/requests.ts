import type { InputRequest, RequestOption, RequestQuestion } from '../../src/shared/types.js';
import { redactStrict } from './normalize.js';

/*
 * What a request for input asks, from the tool call's own input: the questions of
 * AskUserQuestion (Codex request_user_input) and the plan of ExitPlanMode. Agent content is
 * data: redacted (canonical placeholders, localized on read) and capped, never translated; a
 * request a cap cut is marked `truncated` (shown, never answered from the app). Anything
 * malformed is left out rather than guessed. Permission prompts keep nothing here: the tool
 * input of other calls is never stored.
 */

type Obj = Record<string, unknown>;

/** Sizes kept at rest: a request is shown whole on the card, but never grows a record much. */
export const REQUEST_LIMITS = {
  questions: 6,
  options: 12,
  header: 80,
  question: 1000,
  label: 300,
  description: 600,
  plan: 20_000,
  planFile: 400,
} as const;

const L = REQUEST_LIMITS;
/** Whether any cap cut something while reading one request. */
interface Cut {
  cut: boolean;
}
function text(value: unknown, limit: number, c: Cut) {
  if (typeof value !== 'string') return '';
  const full = redactStrict(value.replace(/\r\n?/g, '\n').trim(), Infinity);
  if (full.length > limit) c.cut = true;
  return full.slice(0, limit);
}
function line(value: unknown, limit: number, c: Cut) {
  const one = text(value, Infinity, c).replace(/\s+/g, ' ').trim();
  if (one.length > limit) c.cut = true;
  return one.slice(0, limit);
}
function capped<T>(list: T[], limit: number, c: Cut) {
  if (list.length > limit) c.cut = true;
  return list.slice(0, limit);
}

/** Arguments arrive as an object (Claude) or as a JSON string (Codex function calls). */
export function toolInput(value: unknown): Obj | null {
  if (typeof value === 'string') {
    if (value.length > 200_000) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function option(value: unknown, c: Cut): RequestOption | null {
  // Codex lists plain strings; Claude Code writes { label, description }.
  if (typeof value === 'string') {
    const label = line(value, L.label, c);
    return label ? { label } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Obj;
  const label = line(o.label ?? o.title ?? o.value, L.label, c);
  if (!label) return null;
  const description = text(o.description, L.description, c);
  return description ? { label, description } : { label };
}

function question(value: unknown, c: Cut): RequestQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const q = value as Obj;
  // Claude Code: `question`; Codex request_user_input: `question`, or `title` in later builds.
  const asked = text(q.question ?? q.title ?? q.prompt, L.question, c);
  if (!asked) return null;
  const options = capped(Array.isArray(q.options) ? q.options : [], L.options, c)
    .map((o) => option(o, c))
    .filter((o): o is RequestOption => !!o);
  const header = line(q.header, L.header, c);
  return {
    ...(header ? { header } : {}),
    question: asked,
    multiSelect: q.multiSelect === true || q.multi_select === true,
    options,
  };
}

/** The request a question or plan-approval tool call makes, or undefined when its input has none. */
export function inputRequest(tool: string, input: unknown): InputRequest | undefined {
  const args = toolInput(input);
  if (!args) return undefined;
  const c: Cut = { cut: false };
  const truncated = () => (c.cut ? { truncated: true as const } : {});
  if (/ExitPlanMode/.test(tool)) {
    const plan = text(args.plan, L.plan, c);
    if (!plan) return undefined;
    const planFile = line(args.planFilePath ?? args.plan_file_path, L.planFile, c);
    return { kind: 'plan', plan, ...(planFile ? { planFile } : {}), ...truncated() };
  }
  if (/AskUserQuestion|request_user_input/.test(tool)) {
    const questions = capped(Array.isArray(args.questions) ? args.questions : [], L.questions, c)
      .map((q) => question(q, c))
      .filter((q): q is RequestQuestion => !!q);
    return questions.length ? { kind: 'question', questions, ...truncated() } : undefined;
  }
  return undefined;
}
