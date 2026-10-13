import type { InputRequest, RequestOption, RequestQuestion } from '../../src/shared/types.js';
import { redact } from './normalize.js';

/*
 * What a request for input asks, from the tool call's own input: the questions of
 * AskUserQuestion (Codex request_user_input), the plan of ExitPlanMode, and — for a permission
 * prompt, which only the live process record shows — what the pending call is about. Agent
 * content is data: redacted (canonical placeholders, localized on read) and capped, never
 * translated. Anything malformed is left out rather than guessed.
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
  tool: 120,
  summary: 1000,
  detail: 1200,
} as const;

const L = REQUEST_LIMITS;
const text = (value: unknown, limit: number) =>
  typeof value === 'string' ? redact(value.replace(/\r\n?/g, '\n').trim(), limit) : '';
const line = (value: unknown, limit: number) =>
  text(value, limit * 2)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

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

function option(value: unknown): RequestOption | null {
  // Codex lists plain strings; Claude Code writes { label, description }.
  if (typeof value === 'string') {
    const label = line(value, L.label);
    return label ? { label } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Obj;
  const label = line(o.label ?? o.title ?? o.value, L.label);
  if (!label) return null;
  const description = text(o.description, L.description);
  return description ? { label, description } : { label };
}

function question(value: unknown): RequestQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const q = value as Obj;
  // Claude Code: `question`; Codex request_user_input: `question`, or `title` in later builds.
  const asked = text(q.question ?? q.title ?? q.prompt, L.question);
  if (!asked) return null;
  const options = (Array.isArray(q.options) ? q.options : [])
    .slice(0, L.options)
    .map(option)
    .filter((o): o is RequestOption => !!o);
  const header = line(q.header, L.header);
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
  if (/ExitPlanMode/.test(tool)) {
    const plan = text(args.plan, L.plan);
    if (!plan) return undefined;
    const planFile = line(args.planFilePath ?? args.plan_file_path, L.planFile);
    return { kind: 'plan', plan, ...(planFile ? { planFile } : {}) };
  }
  if (/AskUserQuestion|request_user_input/.test(tool)) {
    const questions = (Array.isArray(args.questions) ? args.questions : [])
      .slice(0, L.questions)
      .map(question)
      .filter((q): q is RequestQuestion => !!q);
    return questions.length ? { kind: 'question', questions } : undefined;
  }
  return undefined;
}

/**
 * What a pending tool call would do, for the permission prompt that may be asking about it:
 * the command, file, address or pattern it names, else its own description. MCP and other
 * tools fall back to a compact view of their input.
 */
export function permissionRequest(tool: string, input: unknown): InputRequest | undefined {
  const args = toolInput(input);
  const name = line(tool, L.tool);
  if (!name) return undefined;
  if (!args) return { kind: 'permission', tool: name, summary: '' };
  const first = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'path']
    .map((key) => args[key])
    .find((value) => typeof value === 'string' && value.trim());
  const description = text(args.description ?? args.prompt, L.detail);
  let summary = text(first, L.summary);
  if (!summary && description) summary = line(description, L.summary);
  if (!summary) {
    let compact = '';
    try {
      compact = JSON.stringify(args);
    } catch {
      /* circular input cannot come from JSON */
    }
    summary = compact && compact !== '{}' ? line(compact, L.summary) : '';
  }
  const detail = description && description !== summary ? description : '';
  return { kind: 'permission', tool: name, summary, ...(detail ? { detail } : {}) };
}
