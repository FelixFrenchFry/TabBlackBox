import { canRestore } from '../../src/ui/restore-state';
import { expect, it } from 'vitest';
import { createSessionDialogLock } from '../../src/ui/restore-state';

it('keeps restore confirmations exclusive until the dialog is released', () =>
{
  const lock = createSessionDialogLock();

  expect(lock.acquire()).toBe(true);
  expect(lock.active).toBe(true);
  expect(lock.acquire()).toBe(false);
  expect(lock.active).toBe(true);

  lock.release();

  expect(lock.active).toBe(false);
  expect(lock.acquire()).toBe(true);
});


it('blocks restore while a backup is pending', () =>
{
  expect(canRestore({ tabCount: 1, backingUp: true, restoring: false })).toBe(false);
});

it('allows a supported restore while idle', () =>
{
  expect(canRestore({ tabCount: 1, backingUp: false, restoring: false })).toBe(true);
});
