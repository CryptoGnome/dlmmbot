/**
 * Serve /assets/umami.js and /setup/umami.js.
 * Blocked visitor IPs come from UMAMI_BLOCKED_IPS (Cloudflare Pages secret) —
 * never from the git repo or the public JS.
 */
const WEBSITE_ID = "3499aa8b-8f9b-4993-8bd5-6b660bebaff6";
const LOADER = `(()=>{const s=document.createElement("script");s.defer=true;s.src="https://cloud.umami.is/script.js";s.dataset.websiteId="${WEBSITE_ID}";document.head.appendChild(s)})();`;

function ipv4ToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function ipMatch(ip, rule) {
  const r = rule.trim();
  if (!r) return false;
  if (ip === r) return true;
  if (!r.includes("/")) return false;
  const [net, bitsStr] = r.split("/");
  const bits = Number(bitsStr);
  const ipN = ipv4ToInt(ip);
  const netN = ipv4ToInt(net || "");
  if (ipN == null || netN == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipN & mask) === (netN & mask);
}

function js(body, cache) {
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": cache,
    },
  });
}

export async function onRequest(context) {
  const ip = context.request.headers.get("CF-Connecting-IP") || "";
  const rules = String(context.env.UMAMI_BLOCKED_IPS || "")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (ip && rules.some((r) => ipMatch(ip, r))) {
    return js("", "private, no-store");
  }
  return js(LOADER, "public, max-age=300");
}
