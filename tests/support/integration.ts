import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';

// isolate database state and browser globals between integration scenarios
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => {
  if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
