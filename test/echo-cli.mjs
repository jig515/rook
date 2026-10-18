// Fake CLI upstream used by the smoke test. Prints claude-style stream-json by
// default; argv[2] selects an output dialect so every parser can be exercised.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const n = input.length;
  const mode = process.argv[2] || 'claude';
  const text = `rook ok (${n} chars on stdin)`;

  if (mode === 'raw') {
    process.stdout.write('rook ');
    process.stdout.write(`ok (${n} chars on stdin)`);
    return;
  }

  if (mode === 'json-lines') {
    for (const piece of ['rook ', 'ok ', `(${n} chars on stdin)`]) {
      console.log(JSON.stringify({ delta: piece }));
    }
    return;
  }

  if (mode === 'json-object') {
    console.log(JSON.stringify({ response: text, usage: { chars: n } }));
    return;
  }

  // claude --output-format stream-json
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }));
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'rook ok' }] } }));
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: ` (${n} chars on stdin)` }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: text, is_error: false }));
});
