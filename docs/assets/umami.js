/** Load Umami unless the visitor IP is on our blocklist (team / home / VPS). */
(() => {
  const WEBSITE_ID = "3499aa8b-8f9b-4993-8bd5-6b660bebaff6";
  // Edit when your public egress changes (home ISP, office, VPS, etc.). CIDR ok.
  const BLOCKED = [
    "REDACTED",
  ];

  function ipv4ToInt(ip) {
    return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  }

  function ipMatch(ip, rule) {
    const r = rule.trim();
    if (!r.includes("/")) return ip === r;
    const [net, bitsStr] = r.split("/");
    const bits = Number(bitsStr);
    if (!net || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
  }

  function isBlocked(ip) {
    return BLOCKED.some((rule) => ipMatch(ip, rule));
  }

  function load() {
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://cloud.umami.is/script.js";
    s.dataset.websiteId = WEBSITE_ID;
    document.head.appendChild(s);
  }

  async function init() {
    try {
      const text = await (await fetch("/cdn-cgi/trace", { credentials: "same-origin" })).text();
      const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim();
      if (ip && isBlocked(ip)) {
        localStorage.setItem("umami.disabled", "true");
        return;
      }
    } catch (_) {}
    load();
  }

  init();
})();
