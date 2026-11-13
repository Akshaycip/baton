// Builds both contracts and copies the wasm to res/, which is what the tests and deploy use.
// Needs Rust and cargo-near. To run the tests alone you do not need this: res/ is checked in.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const target = process.env.CARGO_TARGET_DIR ?? 'target';
mkdirSync('res', { recursive: true });

for (const name of ['vault', 'collection']) {
  execFileSync('cargo', ['near', 'build', 'non-reproducible-wasm', '--no-abi'], {
    cwd: join('contracts', name),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const file = `baton_${name}.wasm`;
  copyFileSync(join(target, 'near', `baton_${name}`, file), join('res', file));
  console.log(`res/${file}`);
}
