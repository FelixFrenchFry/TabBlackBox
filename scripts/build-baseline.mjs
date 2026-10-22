import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// first commit with database version 9, to be replaced by the latest release tag
const ref = 'abc8b4c2250449617964fb584a9bafe7a5c91c77';

if (process.argv.length > 2) throw new Error('This script builds the pinned baseline and does not accept arguments.');

const root = resolve('.baseline', ref.slice(0, 7));
const output = resolve(root, 'chrome-mv3');

function run(command, cwd)
{
  // npm and npx need a shell on Windows
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

// skip if this commit is already built
if (existsSync(resolve(output, 'manifest.json'))) {
  console.log(`Baseline ${ref} already built in ${output}`);
} else {
  mkdirSync(root, { recursive: true });
  const source = mkdtempSync(resolve(root, 'build-'));
  try {
    // copy the pinned commit into a fresh directory
    const archive = spawnSync('git', ['archive', '--format=tar', ref], { maxBuffer: 1024 * 1024 * 512 });
    if (archive.error) throw archive.error;
    if (archive.status !== 0) throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
    const extract = spawnSync('tar', ['-x'], { cwd: source, input: archive.stdout });
    if (extract.error) throw extract.error;
    if (extract.status !== 0) throw new Error(`tar failed: ${extract.stderr.toString()}`);
    run('npm ci --no-audit --no-fund', source);
    run('npx wxt build', source);
    // publish only a completed build on the same filesystem
    renameSync(resolve(source, '.output', 'chrome-mv3'), output);
  } finally {
    // clean up only the directory created by this run
    rmSync(source, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(`Built baseline ${ref} into ${output}`);
}
