import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import type { SavedTab, Session } from '../../src/model';
import { DEFAULT_STORAGE_SETTINGS } from '../../src/storage';

const page = (path: string): SavedTab => ({ url: `https://example.test/${path}`, title: path, pinned: false, group: null });
const session = (path: string): Session => ({ windows: [{ groups: [], tabs: [page(path)] }] });

describe('backup history', () =>
{
  it('reports the oldest retained backup of either collection', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      expect(await repository.oldestCapturedAt()).toBeNull();
      await repository.capture(session('first'), 'automatic', 2000);
      expect(await repository.oldestCapturedAt()).toBe(2000);
      await repository.capture(session('second'), 'automatic', 3000);
      await repository.capture(session('third'), 'automatic', 4000);
      expect(await repository.oldestCapturedAt()).toBe(2000);
      // removing older automatic backups moves the start of the history
      expect(await repository.setStorageSettings({ ...DEFAULT_STORAGE_SETTINGS, maxBackups: 2 }, 1, 5000)).toEqual({ kind: 'saved' });
      expect(await repository.oldestCapturedAt()).toBe(3000);
      // manual backups stay until deleted and can be older than every automatic backup
      await repository.importSaved({ format: 'tabblackbox', version: 1, sessions: [{ ...session('kept'), name: null, capturedAt: 1000, source: 'manual' }] }, 6000);
      expect(await repository.oldestCapturedAt()).toBe(1000);
    } finally { await repository.close(); }
  });
});
