'use strict';

// Test fixture: a tree of node processes that never exit on their own.
// root -> N children -> one grandchild each.
// Prints one JSON line with every pid once the whole tree is running.

const { spawn } = require('node:child_process');

const count = Number(process.argv[2] ?? 3);
const pids = [process.pid];

const KEEP_ALIVE = 'setInterval(() => {}, 1000);';

const childScript = `
const { spawn } = require('node:child_process');
const leaf = spawn(process.execPath, ['-e', '${KEEP_ALIVE}'], { stdio: 'ignore', windowsHide: true });
process.stdout.write(JSON.stringify({ leaf: leaf.pid }));
${KEEP_ALIVE}
`;

function spawnChild() {
  const child = spawn(process.execPath, ['-e', childScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });
  pids.push(child.pid);
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('}');
      if (end === -1) return;
      const parsed = JSON.parse(buffer.slice(0, end + 1));
      pids.push(parsed.leaf);
      resolve();
    });
  });
}

Promise.all(Array.from({ length: count }, spawnChild)).then(
  () => {
    process.stdout.write(`${JSON.stringify(pids)}\n`);
  },
  (error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  }
);
