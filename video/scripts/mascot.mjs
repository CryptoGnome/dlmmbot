/**
 * Generate today's two mascot cards — the video's opening and closing bookends.
 *
 * The character is the pixel-art Meteora meteor mascot (see the article
 * header, docs/article/header-mascot-v4.png, which is passed as the style
 * reference so he stays on-model day to day). What CHANGES each day is his
 * pose, accessory and mood, and those are chosen from the day's own numbers
 * in public/daily.json — a green day celebrates, a red day shrugs, a big
 * trade points at the screen, a bug day holds a wrench. So the bookends are
 * different every day for a reason the viewer can feel, not at random.
 *
 * Reads:   public/daily.json (from data.mjs)
 * Writes:  public/mascot-open.png, public/mascot-close.png (gitignored)
 * Needs:   OPENROUTER_API_KEY. If it is missing or generation fails, the
 *          files are left absent and the video falls back to its plain
 *          title/outro — the daily must never fail because a picture did.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, "..", "public");
const REF = resolve(HERE, "..", "..", "docs", "article", "header-mascot-v4.png");
const MODEL = process.env.MASCOT_MODEL ?? "google/gemini-3-pro-image-preview";
const KEY = process.env.OPENROUTER_API_KEY;

if (!KEY) {
  console.warn("[mascot] OPENROUTER_API_KEY not set — skipping mascot cards (video uses plain title/outro)");
  process.exit(0);
}

const daily = JSON.parse(readFileSync(resolve(PUB, "daily.json"), "utf8"));

// The character, described once, verbatim from memory/art-direction. Every
// prompt starts with this so the model does not drift.
const CHARACTER =
  "the pixel-art Meteora mascot: a round chunky orange-gold meteor character with a glossy molten-orange body " +
  "speckled with dark-brown crater chips like a chocolate-chip cookie, two big round white eyes with dark pupils, " +
  "thick friendly eyebrows and a huge open cheerful grin showing a red tongue, drawn as a stocky pixel sprite in " +
  "crisp 32-bit retro-game style with hard-edged pixels and clean dithering and no anti-aliasing blur";

const STYLE =
  "against a near-black void with a soft Meteora-purple pixel nebula and a scatter of single-pixel stars, " +
  "limited palette of near-black, deep purple, molten orange, brown, neon green and electric blue, " +
  "generous empty dark space across the left third for a headline, no text, no letters, no numbers, no logos";

/**
 * Pick the day's story from its numbers. Ordered by what deserves the frame:
 * a bug day is the most "us" thing to show; then the size of the P&L; then a
 * standout trade; then the quiet default.
 */
function pickScenes(d) {
  const pnl = d.today?.pnl ?? 0;
  const closes = d.today?.closes ?? 0;
  const shipped = d.releases?.length ?? 0;
  const best = d.best?.pnl ?? 0;
  const bigWin = pnl >= 0.05, bigLoss = pnl <= -0.05;

  // opening: how the day STARTS in the viewer's mind — the mood
  let open;
  if (shipped >= 2) open = "sitting at his pixel desk with a wrench in one hand and a coffee mug in the other, sleeves rolled up, determined half-grin, a small pixel toolbox open on the desk";
  else if (bigWin) open = "at his pixel desk leaning back with both arms raised in celebration, wearing pixel sunglasses, the monitor behind him glowing green";
  else if (bigLoss) open = "at his pixel desk with a small shrug, one eyebrow raised, holding a coffee mug, the monitor behind him showing a red dip, calm not sad";
  else if (closes === 0) open = "at his pixel desk with his chin resting on one hand, patiently watching the monitor, a coffee mug steaming beside him, the monitor showing a flat green line";
  else if (best >= 0.05) open = "at his pixel desk pointing excitedly at the monitor with one hand, the monitor showing a green price line ticking sharply upward";
  else open = "at his pixel desk with a small confident nod, hands on the keyboard, the monitor showing a gentle green line";

  // closing: the sign-off — always warmer than the open, it's a wave goodbye
  let close;
  if (bigLoss) close = "standing beside his pixel desk giving a thumbs-up with a small tired smile, a coffee mug on the desk, the monitor dimmed, the mood 'we go again tomorrow'";
  else if (shipped >= 2) close = "standing beside his pixel desk wiping his brow with a small pixel towel and waving with the other hand, the wrench put down on the desk, monitor glowing green";
  else if (bigWin) close = "doing a little pixel victory dance next to his desk with pixel sunglasses on, one fist in the air, monitor glowing green behind him";
  else close = "standing beside his pixel desk waving goodbye with one hand and holding a coffee mug in the other, relaxed and cheerful, monitor glowing softly behind him";

  return { open, close, tag: shipped >= 2 ? "bug-day" : bigWin ? "green-day" : bigLoss ? "red-day" : closes === 0 ? "quiet-day" : "normal-day" };
}

const dataUrl = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;

async function generate(scene, out) {
  const prompt =
    `A wide 16:9 pixel-art illustration of ${CHARACTER}, ${scene}, ${STYLE}. ` +
    `Keep the exact character design, colours and pixel style of the reference image; change only the pose, accessory and expression described.`;
  const content = existsSync(REF)
    ? [{ type: "image_url", image_url: { url: dataUrl(REF) } }, { type: "text", text: prompt }]
    : prompt;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], modalities: ["image", "text"] }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const img = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!img) throw new Error(`no image in response: ${JSON.stringify(json).slice(0, 300)}`);
  writeFileSync(out, Buffer.from(img.replace(/^data:image\/[^;]+;base64,/, ""), "base64"));
}

mkdirSync(PUB, { recursive: true });
const scenes = pickScenes(daily);
console.log(`[mascot] day ${daily.dayNumber} reads as ${scenes.tag}`);
for (const [name, scene] of [["mascot-open", scenes.open], ["mascot-close", scenes.close]]) {
  const out = resolve(PUB, `${name}.png`);
  try {
    await generate(scene, out);
    console.log(`[mascot] ${name} -> ${out}`);
  } catch (e) {
    // Best-effort by design: a missing card degrades to the plain title/outro.
    console.warn(`[mascot] ${name} failed (${e.message.slice(0, 120)}) — video will use plain title/outro`);
  }
}
