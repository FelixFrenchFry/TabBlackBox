import MCR, { type CoverageReportOptions } from 'monocart-coverage-reports';
import type { BrowserContext, Page } from '@playwright/test';

// set by npm run test:browser:coverage
export const coverageEnabled = process.env.TABBLACKBOX_COVERAGE === '1';

// our own source files, not packages
const source = /^(\.\.\/)*(src|entrypoints)\//;

export const coverageOptions: CoverageReportOptions = {
  name: 'TabBlackBox browser test coverage',
  outputDir: 'coverage/browser',
  reports: ['v8', 'console-summary', 'lcovonly', 'json-summary'],
  // extension pages only
  entryFilter: entry => entry.url.startsWith('chrome-extension://'),
  sourceFilter: path => source.test(path),
  // skip builds without source maps like the old update test build
  outputFilter: file => source.test(file.sourcePath),
  // source map paths are relative to the build folder
  sourcePath: path => path.replace(/^(\.\.\/)+/, ''),
};

// collect each page before a controlled page or context close
export async function trackCoverage(context: BrowserContext): Promise<void>
{
  if (!coverageEnabled) return;
  const report = MCR(coverageOptions);
  const pages = new Map<Page, { started: Promise<void>; collected?: Promise<void> }>();
  const collect = (page: Page): Promise<void> => {
    const state = pages.get(page);
    if (!state) return Promise.resolve();
    // share collection between overlapping page and context closes
    state.collected ??= (async () => {
      await state.started;
      if (page.isClosed()) return;
      const entries = await page.coverage.stopJSCoverage().catch((error: unknown) => {
        if (page.isClosed()) return [];
        throw error;
      });
      const own = entries.filter(entry => entry.url.startsWith('chrome-extension://'));
      if (own.length) await report.add(own);
    })();
    return state.collected;
  };
  const start = (page: Page): Promise<void> => {
    let state = pages.get(page);
    if (!state) {
      // pages opened by the extension may miss their first script run
      state = { started: page.coverage.startJSCoverage({ resetOnNavigation: false }).catch(() => { /* page closed too fast */ }) };
      pages.set(page, state);
      const close = page.close.bind(page);
      page.close = async options => {
        try { await collect(page); }
        finally { await close(options); }
      };
    }
    return state.started;
  };
  context.on('page', page => { void start(page); });
  // wait for coverage before tests can navigate a new page
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    await start(page);
    return page;
  };
  const close = context.close.bind(context);
  context.close = async options => {
    try {
      const results = await Promise.allSettled([...pages.keys()].map(collect));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally { await close(options); }
  };
  await Promise.all(context.pages().map(start));
}
