/* DLMM Bot site — scroll scenes + ambient motion.
   Everything here is progressive enhancement: with JS off or reduced motion
   on, the CSS renders every scene complete and static. */
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* —— Reveal on scroll —— */
  const reveals = document.querySelectorAll(".reveal");
  if (reduce) {
    reveals.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach((el) => io.observe(el));
  }

  if (reduce) {
    // Static fallbacks for the scenes: show final states.
    document.querySelectorAll(".pipe-stop").forEach((s) => s.classList.add("on"));
    document.querySelectorAll(".bin").forEach((b, i, all) => {
      if (i < all.length * 0.6) b.classList.add("hit");
    });
    const fee = document.getElementById("feeval");
    if (fee) fee.textContent = "+0.043";
    const line = document.querySelector(".price-line");
    if (line) line.style.setProperty("--x", "38");
    return;
  }

  /* —— Scene progress driver ——
     Each [data-scene] is a tall wrapper with a sticky viewport. Progress is
     how far the wrapper has scrolled through: 0 when its top hits the sticky
     offset, 1 when its bottom leaves the viewport. */
  const scenes = [...document.querySelectorAll("[data-scene]")].map((el) => ({
    el,
    kind: el.getAttribute("data-scene"),
  }));

  /* Pipeline: 5 stages across the scroll. */
  const stops = document.querySelectorAll(".pipe-stop");
  const panels = document.querySelectorAll(".pipe-panel");
  let curStage = -1;
  function pipeline(p) {
    const stage = Math.min(4, Math.floor(p * 5));
    if (stage === curStage) return;
    curStage = stage;
    stops.forEach((s, i) => {
      s.classList.toggle("on", i === stage);
      s.classList.toggle("done", i < stage);
    });
    panels.forEach((pl, i) => pl.classList.toggle("on", i === stage));
  }

  /* Ladder: three beats.
     0.00–0.30 bars grow in, price sits at the right.
     0.30–0.75 price line travels left (down through the range); crossed bins
                light green; the fee counter compounds.
     0.75–1.00 hold the final state on the last beat. */
  const bins = [...document.querySelectorAll(".bin")];
  const priceLine = document.querySelector(".price-line");
  const feeEl = document.getElementById("feeval");
  const beats = document.querySelectorAll(".beat");
  let curBeat = -1;
  function ladder(p) {
    // Grow-in stagger.
    const grow = Math.min(1, p / 0.25);
    bins.forEach((b, i) => {
      const local = Math.min(1, Math.max(0, grow * bins.length - (bins.length - 1 - i) * 0.6));
      b.style.setProperty("--grow", local.toFixed(3));
    });
    // Price travel: right edge (100%) → 38% of the stage width.
    const travel = Math.min(1, Math.max(0, (p - 0.3) / 0.45));
    const eased = 1 - Math.pow(1 - travel, 2);
    const x = 100 - eased * 62;
    if (priceLine) priceLine.style.setProperty("--x", x.toFixed(2));
    // Bins are flex: equal widths across the stage; bin i spans
    // [i/n, (i+1)/n) of the width. A bin is "hit" once the line is left of
    // its right edge.
    const n = bins.length;
    let hits = 0;
    bins.forEach((b, i) => {
      const rightEdge = ((i + 1) / n) * 100;
      const hit = x <= rightEdge;
      b.classList.toggle("hit", hit);
      if (hit) hits++;
    });
    if (feeEl) {
      // Fees compound with depth — deeper travel, more volume traded through.
      const fee = hits === 0 ? 0 : 0.004 * hits + 0.008 * eased;
      feeEl.textContent = `+${fee.toFixed(3)}`;
    }
    const beat = p < 0.3 ? 0 : p < 0.78 ? 1 : 2;
    if (beat !== curBeat) {
      curBeat = beat;
      beats.forEach((el, i) => el.classList.toggle("on", i === beat));
    }
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const navH = 64;
      for (const s of scenes) {
        const rect = s.el.getBoundingClientRect();
        const total = s.el.offsetHeight - (window.innerHeight - navH);
        if (total <= 0) continue;
        const p = Math.min(1, Math.max(0, (navH - rect.top) / total));
        if (rect.bottom < -200 || rect.top > window.innerHeight + 200) continue;
        if (s.kind === "pipeline") pipeline(p);
        else if (s.kind === "ladder") ladder(p);
      }
    });
  }
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  // Initialize stage 0 even before any scroll.
  pipeline(0);
  ladder(0);

  /* —— Hero tick feed: a quiet, looping stream of plausible bot activity. —— */
  const feed = document.getElementById("tickfeed");
  if (feed) {
    const SCRIPT = [
      ["WIF", "mark · in range · fees accruing", "+0.003 SOL", "ok"],
      ["MOODENG", "vet failed: insider cluster 14%", "skipped", "t"],
      ["BONK", "fee claim", "+0.019 SOL", "ok"],
      ["PONKE", "entered BidAsk −40%", "0.450 SOL", "acc"],
      ["WIF", "profit lock at +32%", "+0.190 SOL", "ok"],
      ["HYPERSOL", "P0 safety: TVL drain", "closed", "bad"],
      ["scan", "swept 300 pools → 3 candidates", "", "t"],
      ["PONKE", "closed · P3 take-profit", "+0.077 SOL", "ok"],
      ["rent", "reclaimed empty token account", "+0.002 SOL", "ok"],
      ["COPYCAT", "vet failed: creator rugged before", "blacklisted", "t"],
    ];
    let idx = 0;
    const pad = (n) => String(n).padStart(2, "0");
    setInterval(() => {
      if (document.hidden) return;
      const [sym, msg, amt, cls] = SCRIPT[idx % SCRIPT.length];
      idx++;
      const d = new Date();
      const row = document.createElement("div");
      row.className = "mock-row enter-row";
      const amtCls = cls === "t" ? "t" : cls;
      row.innerHTML =
        `<span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}</span>` +
        `<span>${sym} · ${msg}</span>` +
        `<span class="${amtCls}">${amt}</span>`;
      feed.prepend(row);
      while (feed.children.length > 4) feed.lastElementChild.remove();
    }, 2600);
  }
})();
