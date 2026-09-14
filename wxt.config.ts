import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: {
    name: 'TabBlackBox',
    description: 'Automatic backups, versioning, and restoration of browser tabs and sessions.',
    minimum_chrome_version: '120',
    permissions: ['tabs', 'tabGroups', 'alarms', 'unlimitedStorage', 'favicon'],
    host_permissions: ['file:///*'],
    incognito: 'not_allowed',
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
  },
});
