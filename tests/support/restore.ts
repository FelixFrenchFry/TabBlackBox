import type { RestorePort } from '../../src/restore';

export function createRestorePort(): RestorePort
{
  return {
    fileAccess: async () => false,
    createWindow: async () => ({ windowId: 1, tabId: 1 }),
    createTab: async () => 2,
    pinTab: async () => undefined,
    groupTabs: async () => undefined,
    createPlaceholderTab: async () => 2,
  };
}
