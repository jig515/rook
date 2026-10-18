/** Unit test for the thinking-strength translation layer. */
import { applyThinking, normalizeLevel, pickReasoning } from '../src/thinking.js';

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log('  ✓ ' + n);
  } else {
    fail++;
    console.log('  ✕ ' + n + (extra ? ' → ' + extra : ''));
  }
};

console.log('\nthinking layer\n');

ok('level aliases', normalizeLevel('MAX') === 'max' && normalizeLevel('none') === 'off' && normalizeLevel('mid') === 'medium');
ok('unknown falls back', normalizeLevel('warp9', 'low') === 'low');

{
  const b = {};
  applyThinking(b, { thinking: { style: 'reasoning_effort' } }, 'high');
  ok('reasoning_effort/high', b.reasoning_effort === 'high', JSON.stringify(b));
  const off = { reasoning_effort: 'low' };
  applyThinking(off, { thinking: { style: 'reasoning_effort' } }, 'off');
  ok('reasoning_effort/off removes param', !('reasoning_effort' in off));
}
{
  const b = {};
  applyThinking(b, { thinking: { style: 'openrouter_reasoning' } }, 'low');
  ok('openrouter effort', b.reasoning?.effort === 'low', JSON.stringify(b));
  const off = {};
  applyThinking(off, { thinking: { style: 'openrouter_reasoning' } }, 'off');
  ok('openrouter off disables', off.reasoning?.enabled === false);
}
{
  const b = {};
  applyThinking(b, { thinking: { style: 'qwen_enable' } }, 'medium');
  ok('qwen enable + budget', b.enable_thinking === true && b.thinking_budget === 4096, JSON.stringify(b));
  const off = { enable_thinking: true, thinking_budget: 4096 };
  applyThinking(off, { thinking: { style: 'qwen_enable' } }, 'off');
  ok('qwen off', off.enable_thinking === false && !('thinking_budget' in off));
}
{
  const b = {};
  applyThinking(b, { thinking: { style: 'gemini_budget' } }, 'low');
  ok('gemini thinkingConfig', b.generationConfig?.thinkingConfig?.thinkingBudget === 1024, JSON.stringify(b));
}
{
  const b = {};
  applyThinking(
    b,
    { thinking: { style: 'custom', template: { reasoning: { effort: '{{level}}', max_tokens: '{{budget}}' } } } },
    'medium'
  );
  ok(
    'custom template placeholders',
    b.reasoning?.effort === 'medium' && b.reasoning?.max_tokens === 4096,
    JSON.stringify(b)
  );
}
{
  const b = { model: 'x' };
  applyThinking(b, { thinking: { style: 'none' } }, 'max');
  ok('style none leaves body alone', JSON.stringify(b) === '{"model":"x"}');
}
{
  ok('pickReasoning reasoning_content', pickReasoning({ reasoning_content: 'a' }) === 'a');
  ok('pickReasoning object thinking', pickReasoning({ thinking: { content: 'b' } }) === 'b');
  ok('pickReasoning absent', pickReasoning({ content: 'x' }) === undefined);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
