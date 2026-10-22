import { EventEmitter } from 'node:events';
import type { BrowserContext, Page } from '@playwright/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('monocart-coverage-reports', () => ({ default: () => report }));

// browser operations stay pending until the test releases coverage setup
function fixture()
{
  const events = new EventEmitter();
  const setup = Promise.withResolvers<void>();
  const pageClose = vi.fn(async () => {});
  const page = {
    coverage: {
      startJSCoverage: vi.fn(() => setup.promise),
      stopJSCoverage: vi.fn(async () => []),
    },
    isClosed: vi.fn(() => false),
    close: pageClose,
  };
  pageClose.mockImplementation(async () => { page.isClosed.mockReturnValue(true); });
  const pages: Page[] = [];
  const close = vi.fn(async () => {});
  const newPage = vi.fn(async () => {
    events.emit('page', page);
    return page;
  });
  const context = { pages: () => pages, on: events.on.bind(events), newPage, close };
  return { context: context as unknown as BrowserContext, page: page as unknown as Page, pages, setup, events, close, newPage, pageClose };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('TABBLACKBOX_COVERAGE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('waits for existing pages before returning the extension context', async () =>
{
  const app = fixture();
  app.pages.push(app.page);
  const { chromium } = await import('@playwright/test');
  vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue(app.context);
  const { launchExtension } = await import('../browser/fixtures/extension');
  const ready = vi.fn();
  const launched = launchExtension('').then(ready);
  try {
    await vi.waitFor(() => expect(app.page.coverage.startJSCoverage).toHaveBeenCalledOnce());
    expect(ready).not.toHaveBeenCalled();
  } finally { app.setup.resolve(); await launched; }
  expect(ready).toHaveBeenCalledExactlyOnceWith(app.context);
});

it('waits for new page coverage and shares setup with the page event', async () =>
{
  const app = fixture();
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  const ready = vi.fn();
  const opened = app.context.newPage().then(ready);
  try {
    await vi.waitFor(() => expect(app.newPage).toHaveBeenCalledOnce());
    expect(ready).not.toHaveBeenCalled();
  } finally { app.setup.resolve(); await opened; }
  expect(ready).toHaveBeenCalledExactlyOnceWith(app.page);
  expect(app.page.coverage.startJSCoverage).toHaveBeenCalledExactlyOnceWith({ resetOnNavigation: false });
});

it('waits for pending page setup before collecting coverage and closing', async () =>
{
  const app = fixture();
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  app.events.emit('page', app.page);
  const closing = app.context.close({ reason: 'finished' });
  try {
    await Promise.resolve();
    expect(app.page.coverage.stopJSCoverage).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
  } finally { app.setup.resolve(); await closing; }
  expect(app.page.coverage.stopJSCoverage).toHaveBeenCalledOnce();
  expect(app.close).toHaveBeenCalledExactlyOnceWith({ reason: 'finished' });
});

it('allows a page to close while coverage setup is pending', async () =>
{
  const app = fixture();
  vi.mocked(app.page.isClosed).mockReturnValue(true);
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  const opened = app.context.newPage();
  app.setup.reject(new Error('Page closed'));
  await expect(opened).resolves.toBe(app.page);
  await app.context.close();
  expect(app.page.coverage.stopJSCoverage).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledOnce();
});

it('leaves context operations unchanged when coverage is disabled', async () =>
{
  vi.stubEnv('TABBLACKBOX_COVERAGE', '0');
  const app = fixture();
  app.pages.push(app.page);
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  expect(app.context.newPage).toBe(app.newPage);
  expect(app.context.close).toBe(app.close);
  expect(app.page.coverage.startJSCoverage).not.toHaveBeenCalled();
});

it('collects a page before closing it and does not collect it again with the context', async () =>
{
  const app = fixture();
  const entry = { url: 'chrome-extension://test/popup.js', scriptId: '1', source: 'popup()', functions: [] };
  vi.mocked(app.page.coverage.stopJSCoverage).mockResolvedValue([entry, { ...entry, url: 'https://example.test/page.js' }]);
  app.pages.push(app.page);
  app.setup.resolve();
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  await app.page.close({ reason: 'finished' });
  expect(report.add).toHaveBeenCalledExactlyOnceWith([entry]);
  expect(app.pageClose).toHaveBeenCalledExactlyOnceWith({ reason: 'finished' });
  await app.context.close();
  expect(app.page.coverage.stopJSCoverage).toHaveBeenCalledOnce();
  expect(report.add).toHaveBeenCalledOnce();
});

it('shares collection between overlapping page and context closes', async () =>
{
  const app = fixture();
  const added = Promise.withResolvers<void>();
  report.add.mockImplementationOnce(() => added.promise);
  vi.mocked(app.page.coverage.stopJSCoverage).mockResolvedValue([{ url: 'chrome-extension://test/popup.js', scriptId: '1', source: 'popup()', functions: [] }]);
  app.pages.push(app.page);
  app.setup.resolve();
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  const closing = Promise.all([app.page.close(), app.context.close()]);
  try {
    await vi.waitFor(() => expect(report.add).toHaveBeenCalledOnce());
    expect(app.pageClose).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
  } finally { added.resolve(); await closing; }
  expect(app.page.coverage.stopJSCoverage).toHaveBeenCalledOnce();
  expect(report.add).toHaveBeenCalledOnce();
  expect(app.pageClose).toHaveBeenCalledOnce();
  expect(app.close).toHaveBeenCalledOnce();
});

it('still closes the page and context when writing coverage fails', async () =>
{
  const app = fixture();
  report.add.mockRejectedValueOnce(new Error('Could not write coverage'));
  vi.mocked(app.page.coverage.stopJSCoverage).mockResolvedValue([{ url: 'chrome-extension://test/popup.js', scriptId: '1', source: 'popup()', functions: [] }]);
  app.pages.push(app.page);
  app.setup.resolve();
  const { trackCoverage } = await import('../browser/fixtures/coverage');
  await trackCoverage(app.context);
  await expect(app.page.close()).rejects.toThrow('Could not write coverage');
  expect(app.pageClose).toHaveBeenCalledOnce();
  await expect(app.context.close()).rejects.toThrow('Could not write coverage');
  expect(app.close).toHaveBeenCalledOnce();
});
