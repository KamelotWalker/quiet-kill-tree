'use strict';

// root -> N children -> one grandchild each. Every process reports readiness
// only after its signal handler is installed, including the grandchildren.
const { spawn } = require('node:child_process');
const count = Number(process.argv[2] ?? 3);
const ignoreSigterm = process.argv[3] === 'true';
const pids = [process.pid];
if (ignoreSigterm) process.on('SIGTERM', () => {});

const leafScript = `
if (${ignoreSigterm}) process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
process.stdout.write('ready\\n');
`;
const childScript = `
const { spawn } = require('node:child_process');
if (${ignoreSigterm}) process.on('SIGTERM', () => {});
const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(leafScript)}], {
  stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
});
leaf.stdout.once('data', () => {
  process.stdout.write(JSON.stringify({ leaf: leaf.pid }) + '\\n');
});
setInterval(() => {}, 1000);
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
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const parsed = JSON.parse(buffer.slice(0, end));
      pids.push(parsed.leaf);
      resolve();
    });
  });
}

Promise.all(Array.from({ length: count }, spawnChild)).then(
  () => process.stdout.write(`${JSON.stringify(pids)}\n`),
  (error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  }
);
