/**
 * Screenshot the live dashboard tabs into public/shots/.
 *
 * Headless on purpose: the daily render has to work unattended, so this cannot
 * lean on an interactive browser. Captured at the video's own width so a crop
 * in the composition is 1:1 pixels, at deviceScaleFactor 2 so type stays sharp
 * when a scene scales a tile up.
 *
 *   DASH_URL / DASH_TOKEN  as per data.mjs
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "..", "public", "shots");

const BASE = process.env.DASH_URL ?? "https://dlmmbot-production.up.railway.app";
const TOKEN = process.env.DASH_TOKEN;
if (!TOKEN) {
  console.error("DASH_TOKEN is required.");
  process.exit(1);
}

// Tab -> hash route. Kept to the four that carry the daily story.
const TABS = [
  ["overview", "#/overview"],
  ["positions", "#/positions"],
  ["analytics", "#/analytics"],
  ["activity", "#/activity"],
];

/**
 * Panels worth showing on their own, located by their visible heading rather
 * than by pixel box. Hand-tuned crops break silently the next time the
 * dashboard reflows; a heading that disappears fails loudly here instead.
 * [output name, tab hash, heading text]
 */
const PANELS = [
  ["equity", "#/analytics", "EQUITY & DAILY CLOSES"],
  ["reasons", "#/analytics", "P&L BY EXIT REASON"],
];

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

try {
  await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: "networkidle", timeout: 60_000 });
  // Wait for real data, not just the shell: the balance tile only renders a SOL
  // figure once the first watch payload lands.
  await page.getByText(/SOL/).first().waitFor({ timeout: 30_000 });

  // Toasts float over the UI and would freeze into the video.
  await page.addStyleTag({ content: '[class*="fixed"][class*="z-"] { display: none !important; }' });

  for (const [name, hash] of TABS) {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    // The SPA swaps synchronously but charts/tables paint a frame later.
    await page.waitForTimeout(1500);
    const file = resolve(SHOTS, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`captured ${name} -> ${file}`);
  }

  for (const [name, hash, heading] of PANELS) {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await page.waitForTimeout(1200);
    // The heading sits inside the panel chrome; walk up to the panel box.
    const panel = page.locator("div").filter({ hasText: heading }).last();
    try {
      await panel.waitFor({ timeout: 10_000 });
      const file = resolve(SHOTS, `${name}.png`);
      await panel.screenshot({ path: file });
      console.log(`captured panel ${name} -> ${file}`);
    } catch {
      console.warn(`panel "${heading}" not found — skipping ${name} (scene falls back to the full tab)`);
    }
  }
} finally {
  await browser.close();
}
