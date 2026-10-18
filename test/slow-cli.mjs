// Slow CLI upstream: emits one chunk, then finishes 2.5s later and drops a
// sentinel file. Used to prove that aborting a request kills the child process
// (the sentinel must never appear).
import fs from 'node:fs';

const flag = process.argv[2];
console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'started' }] } }));

setTimeout(() => {
  try {
    if (flag) fs.writeFileSync(flag, 'finished');
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ type: 'result', result: 'started finished' }));
}, 2500);
