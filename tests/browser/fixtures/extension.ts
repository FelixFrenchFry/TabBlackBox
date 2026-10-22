import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { enableAutomaticBackups } from './automatic';
import { trackCoverage } from './coverage';

export type ExtensionOptions = Pick<NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>, 'viewport' | 'locale' | 'hasTouch' | 'ignoreDefaultArgs'>;
export type ExtensionContext = (options?: ExtensionOptions) => Promise<BrowserContext>;
type ExtensionFixtures = { extensionContext: ExtensionContext };
type WorkerFixtures = { testServer: string };

// loads the current build unless another one is passed
export async function launchExtension(profile: string, options: ExtensionOptions = {}, extension = resolve('.output/chrome-mv3')): Promise<BrowserContext>
{
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...options,
  });
  await trackCoverage(context);
  return context;
}

// an empty profile path launches a temporary profile that is removed when the context closes
export async function launchAutomaticBackups(profile = '')
{
  const context = await launchExtension(profile, { ignoreDefaultArgs: ['--hide-scrollbars'], viewport: { width: 1280, height: 900 } });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/backups.html`);
    await enableAutomaticBackups(page);
    await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
    return { context, page, extensionId };
  } catch (error) { await context.close(); throw error; }
}

export const test = base.extend<ExtensionFixtures, WorkerFixtures>({
  extensionContext: async ({}, use) => {
    const contexts: BrowserContext[] = [];
    try {
      // temporary profiles are removed when their owning contexts close
      await use(async options => {
        const context = await launchExtension('', options);
        contexts.push(context);
        return context;
      });
    } finally { await Promise.all(contexts.map(context => context.close())); }
  },
  testServer: [async ({}, use) => {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Research ${request.url}</title><h1>Local test page</h1>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not start');
      await use(`http://127.0.0.1:${address.port}`);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, { scope: 'worker' }],
});

export { expect };
