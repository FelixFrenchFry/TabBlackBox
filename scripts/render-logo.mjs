import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.test-browsers');
const activeLogo = 'tabblackbox-orange';
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const name of ['tabblackbox', 'tabblackbox-stacked', 'tabblackbox-orange', 'tabblackbox-outlined']) {
    const svg = await readFile(`assets/logo/${name}.svg`, 'utf8');
    for (const size of [16, 20, 24, 32, 48, 128, 512]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
      await page.screenshot({ path: `assets/logo/${name}-${size === 512 ? 'preview' : size}.png`, omitBackground: true });
    }
  }
  await mkdir('public/icon', { recursive: true });
  for (const size of [16, 32, 48, 128]) await copyFile(`assets/logo/${activeLogo}-${size}.png`, `public/icon/${size}.png`);
  await copyFile(`assets/logo/${activeLogo}.svg`, 'public/icon/logo.svg');

  const svg = await readFile(`assets/logo/${activeLogo}.svg`, 'utf8');
  const rows = ['#ffffff', '#808080', '#30343b'].map(background => `<section style="background:${background}">${[16, 20, 32, 128].map(size => `<div><span style="width:${size}px;height:${size}px">${svg}</span><label>${size} px</label></div>`).join('')}</section>`).join('');
  await page.setViewportSize({ width: 640, height: 560 });
  await page.setContent(`<style>body{margin:0;font:13px system-ui}section{display:flex;align-items:center;justify-content:space-around;height:180px}div{display:flex;flex-direction:column;align-items:center;gap:12px;width:140px}span{display:block}svg{width:100%;height:100%;display:block}label{background:white;color:#111;padding:2px 6px;border-radius:4px}</style>${rows}`);
  await page.screenshot({ path: 'assets/logo/tabblackbox-orange-preview.png', clip: { x: 0, y: 0, width: 640, height: 540 } });
} finally { await browser.close(); }
