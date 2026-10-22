import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  existsSync: vi.fn(), mkdirSync: vi.fn(), mkdtempSync: vi.fn(), renameSync: vi.fn(), rmSync: vi.fn(),
}));
const commands = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', () => filesystem);
vi.mock('node:child_process', () => commands);

const script = new URL('../../scripts/build-baseline.mjs', import.meta.url).href;
const ref = 'abc8b4c2250449617964fb584a9bafe7a5c91c77';
const root = resolve('.baseline/abc8b4c');
const source = resolve(root, 'build-owned');
const output = resolve(root, 'chrome-mv3');
const argv = process.argv;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = ['node', 'scripts/build-baseline.mjs'];
  filesystem.existsSync.mockReturnValue(false);
  filesystem.mkdtempSync.mockReturnValue(source);
  commands.spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from('archive'), stderr: Buffer.alloc(0) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['..', resolve('outside'), '--force'])('rejects %s before filesystem changes or commands', async argument =>
{
  process.argv.push(argument);
  await expect(import(script)).rejects.toThrow('does not accept arguments');
  for (const method of Object.values(filesystem)) expect(method).not.toHaveBeenCalled();
  expect(commands.spawnSync).not.toHaveBeenCalled();
});

it('reuses a completed baseline without creating or deleting directories', async () =>
{
  filesystem.existsSync.mockImplementation(path => path === resolve(output, 'manifest.json'));
  await import(script);
  expect(commands.spawnSync).not.toHaveBeenCalled();
  expect(filesystem.mkdirSync).not.toHaveBeenCalled();
  expect(filesystem.mkdtempSync).not.toHaveBeenCalled();
  expect(filesystem.renameSync).not.toHaveBeenCalled();
  expect(filesystem.rmSync).not.toHaveBeenCalled();
});

it('builds the pinned commit in a fresh directory and deletes only that directory', async () =>
{
  vi.stubEnv('TABBLACKBOX_BASELINE_REF', '..');
  await import(script);
  expect(filesystem.mkdtempSync).toHaveBeenCalledWith(resolve(root, 'build-'));
  expect(commands.spawnSync).toHaveBeenNthCalledWith(1, 'git', ['archive', '--format=tar', ref], expect.any(Object));
  expect(commands.spawnSync).toHaveBeenNthCalledWith(2, 'tar', ['-x'], expect.objectContaining({ cwd: source }));
  for (const command of ['npm ci --no-audit --no-fund', 'npx wxt build']) {
    expect(commands.spawnSync).toHaveBeenCalledWith(command, expect.objectContaining({ cwd: source }));
  }
  expect(filesystem.renameSync).toHaveBeenCalledWith(resolve(source, '.output/chrome-mv3'), output);
  expect(filesystem.rmSync).toHaveBeenCalledExactlyOnceWith(source, { recursive: true, force: true, maxRetries: 3 });
});

it.each([1, 2, 3, 4])('cleans only its temporary directory when command %s fails', async at =>
{
  let count = 0;
  commands.spawnSync.mockImplementation(() => ({ status: ++count === at ? 1 : 0, stdout: Buffer.from('archive'), stderr: Buffer.from('failed') }));
  await expect(import(script)).rejects.toThrow('failed');
  expect(filesystem.renameSync).not.toHaveBeenCalled();
  expect(filesystem.rmSync).toHaveBeenCalledExactlyOnceWith(source, { recursive: true, force: true, maxRetries: 3 });
});

it('cleans only its temporary directory if publishing the build fails', async () =>
{
  filesystem.renameSync.mockImplementation(() => { throw new Error('Could not publish baseline'); });
  await expect(import(script)).rejects.toThrow('Could not publish baseline');
  expect(filesystem.rmSync).toHaveBeenCalledExactlyOnceWith(source, { recursive: true, force: true, maxRetries: 3 });
});
