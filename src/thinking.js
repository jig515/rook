/**
 * Thinking-strength translation layer.
 *
 * Every upstream exposes "how hard should it think" differently:
 * OpenAI uses `reasoning_effort`, Anthropic uses a token budget,
 * Gemini uses `thinkingConfig`, Qwen uses `enable_thinking`, and CLI
 * tools take a plain flag. The gateway keeps ONE vocabulary — a level —
 * and each provider declares how that level is rendered.
 */

export const LEVELS = ['off', 'low', 'medium', 'high', 'max'];

export const DEFAULT_BUDGETS = {
  off: 0,
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 32768
};

export function normalizeLevel(v, fallback = 'off') {
  if (typeof v === 'number') {
    if (v <= 0) return 'off';
    if (v <= 2048) return 'low';
    if (v <= 8192) return 'medium';
    if (v <= 24576) return 'high';
    return 'max';
  }
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (LEVELS.includes(s)) return s;
  if (['none', 'disabled', 'false', '0', 'no'].includes(s)) return 'off';
  if (['minimal', 'min', 'lowest'].includes(s)) return 'low';
  if (['mid', 'middle', 'normal', 'default', 'true', 'yes'].includes(s)) return 'medium';
  if (['high', 'hight'].includes(s)) return 'high';
  if (['max', 'maximum', 'ultra', 'highest'].includes(s)) return 'max';
  return fallback;
}

export function budgetsOf(provider) {
  return { ...DEFAULT_BUDGETS, ...(provider?.thinking?.budgets || {}) };
}

/**
 * Mutates `body` (an upstream request payload) according to the provider's
 * thinking style. Returns a small descriptor used for logging.
 */
export function applyThinking(body, provider, level) {
  const style = provider?.thinking?.style || 'none';
  const lvl = normalizeLevel(level);
  const budgets = budgetsOf(provider);
  const budget = budgets[lvl] || 0;

  switch (style) {
    case 'reasoning_effort': {
      if (lvl === 'off') {
        delete body.reasoning_effort;
      } else {
        // Most relays only accept minimal|low|medium|high.
        body.reasoning_effort = provider?.thinking?.map?.[lvl] || lvl;
      }
      break;
    }
    case 'openrouter_reasoning': {
      if (lvl === 'off') body.reasoning = { enabled: false };
      else body.reasoning = { effort: provider?.thinking?.map?.[lvl] || lvl };
      break;
    }
    case 'qwen_enable': {
      body.enable_thinking = lvl !== 'off';
      if (lvl === 'off') delete body.thinking_budget;
      else body.thinking_budget = budget;
      break;
    }
    case 'gemini_budget': {
      const gc = body.generationConfig || (body.generationConfig = {});
      if (lvl === 'off') gc.thinkingConfig = { thinkingBudget: 0 };
      else gc.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
      break;
    }
    case 'custom': {
      const tpl = provider?.thinking?.template;
      if (tpl && typeof tpl === 'object') {
        const on = lvl === 'off' ? 'false' : 'true';
        const rendered = JSON.parse(
          JSON.stringify(tpl)
            .replaceAll('"{{budget}}"', String(budget))
            .replaceAll('"{{level}}"', JSON.stringify(lvl))
            .replaceAll('"{{on}}"', on)
            .replaceAll('{{budget}}', String(budget))
            .replaceAll('{{level}}', lvl)
            .replaceAll('{{on}}', on)
        );
        Object.assign(body, rendered);
      }
      break;
    }
    case 'none':
    default:
      break;
  }
  return { style, level: lvl, budget };
}

/** Pull reasoning/thinking text out of an OpenAI-style delta or message. */
export function pickReasoning(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  const cands = [obj.reasoning_content, obj.reasoning, obj.thinking, obj.reasoning_text];
  for (const c of cands) {
    if (typeof c === 'string' && c) return c;
    if (c && typeof c === 'object' && typeof c.content === 'string' && c.content) return c.content;
  }
  return undefined;
}
