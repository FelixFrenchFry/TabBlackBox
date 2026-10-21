import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/database';
import type { Operation } from '../../src/model';
import { openReleasedDatabase, releasedMetadata } from '../support/released';

// use the released operation shape without the optional report fields
const operation: Operation = { kind: 'completed', snapshotId: 'saved', startedAt: 1, finishedAt: 2, opened: 1, failed: 1, skipped: 0, groupErrors: 0, total: 2, errors: ['Window 1: Tab refused'] };

describe('stored restoration results', () =>
{
  it('keeps a released version 9 result readable and persists its dismissal across reopening', async () =>
  {
    const name = crypto.randomUUID();
    const database = await openReleasedDatabase(name);
    await database.put('metadata', releasedMetadata({ operation }), 'state');
    database.close();
    const repository = new Repository(name);
    try {
      expect((await repository.metadata()).operation).toEqual(operation);
      await repository.dismissOperation('saved', 1);
      await repository.close();
      expect((await repository.metadata()).operation).toEqual({ ...operation, dismissed: true });
    } finally { await repository.close(); }
  });

  it('does not dismiss a newer result or a running restoration', async () =>
  {
    const repository = new Repository(crypto.randomUUID());
    try {
      const newer = { ...operation, startedAt: 3 };
      await repository.setOperation(newer);
      await repository.dismissOperation('saved', 1);
      await repository.dismissOperation('other', 3);
      expect((await repository.metadata()).operation).toEqual(newer);
      const running: Operation = { ...operation, kind: 'running' };
      await repository.setOperation(running);
      await repository.dismissOperation('saved', 1);
      expect((await repository.metadata()).operation).toEqual(running);
      await repository.recoverOperation(4);
      expect((await repository.metadata()).operation).toEqual({ ...operation, kind: 'interrupted', finishedAt: 4 });
    } finally { await repository.close(); }
  });
});
