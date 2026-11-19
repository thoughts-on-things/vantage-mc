// Renders the README cards in cards.html to docs/readme/*.webp.
//
//   npm --prefix site ci          # provides the site's fonts
//   node docs/readme/source/render.mjs
//
// Needs Playwright (with Chromium) and ffmpeg on PATH. The cave-view clip is
// encoded from the site's capture:
//   ffmpeg -i site/src/assets/cave-slice.webm -vf "fps=12,scale=800:-2:flags=lanczos" \
//     -c:v libwebp -q:v 58 -compression_level 6 -loop 0 -an docs/readme/cave-view.webp
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Playwright is not a repo dependency: use any install require() can find
// (a global one works with NODE_PATH="$(npm root -g)").
const { chromium } = createRequire(import.meta.url)('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const cards = { hero: 'hero', viewport: 'demo', bench: 'benchmark', flow: 'multiplayer' };
const quality = { viewport: 82 };

const tmp = mkdtempSync(join(tmpdir(), 'vantage-readme-'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(join(here, 'cards.html')).href);
  await page.evaluate(() => document.fonts.ready);
  for (const [id, name] of Object.entries(cards)) {
    const png = join(tmp, `${id}.png`);
    await page.locator(`#${id}`).screenshot({ path: png, omitBackground: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-q:v', String(quality[id] ?? 90), join(out, `${name}.webp`)]);
    console.log(`docs/readme/${name}.webp`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
