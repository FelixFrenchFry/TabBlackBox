import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uses only the intended permissions without page overrides or content scripts', () =>
{
  const manifest = JSON.parse(readFileSync('.output/chrome-mv3/manifest.json', 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest).not.toHaveProperty('chrome_url_overrides');
  expect(manifest).not.toHaveProperty('content_scripts');
  expect(manifest.permissions).toEqual(['tabs', 'tabGroups', 'alarms', 'unlimitedStorage', 'favicon', 'sessions']);
  expect(manifest.host_permissions).toEqual(['file:///*']);
  expect(manifest.optional_permissions ?? []).toEqual([]);
  expect(manifest.optional_host_permissions ?? []).toEqual([]);
});
