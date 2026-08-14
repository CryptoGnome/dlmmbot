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
    const mockRoot = document.getElementById("hero-mock");
    if (mockRoot) initHeroMock(mockRoot, true);
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

  /* —— Hero dashboard mock: live-feeling stats + feed —— */
  const mockRoot = document.getElementById("hero-mock");
  if (mockRoot) initHeroMock(mockRoot);
})();

function initHeroMock(root, staticOnly = false) {
  const feed = document.getElementById("tickfeed");
  const balEl = document.getElementById("mock-bal");
  const openEl = document.getElementById("mock-open");
  const p24El = document.getElementById("mock-24h");
  const slotsEl = document.getElementById("mock-slots");
  const closesEl = document.getElementById("mock-closes");
  const hbEl = document.getElementById("mock-hb");
  const sparkLine = document.getElementById("mock-spark-line");
  const nav = document.getElementById("mock-nav");
  const posEls = [...root.querySelectorAll(".mock-pos")];

  const state = {
    balance: 12.4,
    openPnl: 0.084,
    pnl24: 0.182,
    openCount: 3,
    maxSlots: 5,
    closes24: 11,
    hb: 8,
    chartY: [28, 26, 22, 18, 14, 12, 8],
    positions: [
      { sol: 72, tick: 68, pnl: 3.2, badge: "in", cls: "ok" },
      { sol: 38, tick: 22, pnl: -1.1, badge: "below", cls: "bad" },
    ],
  };

  const fmtSigned = (n, d = 3) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
  const pad = (n) => String(n).padStart(2, "0");

  function flash(el, dir) {
    if (!el) return;
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth;
    el.classList.add(dir === "up" ? "flash-up" : "flash-down");
  }

  function renderStats() {
    if (balEl) balEl.textContent = `${state.balance.toFixed(2)} SOL`;
    if (openEl) {
      openEl.textContent = fmtSigned(state.openPnl);
      openEl.className = `val ${state.openPnl >= 0 ? "ok" : "bad"}`;
    }
    if (p24El) {
      p24El.textContent = fmtSigned(state.pnl24);
      p24El.className = `val ${state.pnl24 >= 0 ? "ok" : "bad"}`;
    }
    if (slotsEl) {
      const free = state.maxSlots - state.openCount;
      slotsEl.textContent = `${state.openCount} of ${state.maxSlots} · ${free} free`;
    }
    if (closesEl) closesEl.textContent = `${state.closes24} closes`;
    if (hbEl) hbEl.textContent = String(state.hb);
  }

  function renderPositions() {
    posEls.forEach((el, i) => {
      const p = state.positions[i];
      if (!p) return;
      const fill = el.querySelector(".mock-range-fill");
      const tick = el.querySelector(".mock-range-tick");
      const pnl = el.querySelector(".mock-pos-pnl");
      const badge = el.querySelector(".mock-pos-badge");
      if (fill) fill.style.setProperty("--sol", `${p.sol}%`);
      if (tick) {
        tick.style.setProperty("--x", `${p.tick}%`);
        tick.classList.toggle("warn", p.badge === "below");
      }
      if (pnl) {
        pnl.textContent = `${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(1)}%`;
        pnl.className = `mock-pos-pnl ${p.cls}`;
      }
      if (badge) {
        badge.textContent = p.badge === "in" ? "in range" : "below range";
        badge.className = `mock-pos-badge ${p.badge}`;
      }
    });
  }

  function renderSpark() {
    if (!sparkLine) return;
    const pts = state.chartY.map((y, i) => {
      const x = (i / Math.max(state.chartY.length - 1, 1)) * 120;
      return `${x.toFixed(1)},${y}`;
    });
    sparkLine.setAttribute("points", pts.join(" "));
  }

  renderStats();
  renderPositions();
  renderSpark();
  if (staticOnly) return;

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
    ["BONKE", "unclaimed fees crossed threshold", "+0.011 SOL", "ok"],
    ["COPYCAT", "vet failed: creator rugged before", "blacklisted", "t"],
    ["TRUMP", "cluster brake · entries paused", "", "warn"],
  ];
  let scriptIdx = 0;
  let tabIdx = 0;

  if (feed) {
    setInterval(() => {
      if (document.hidden) return;
      const [sym, msg, amt, cls] = SCRIPT[scriptIdx++ % SCRIPT.length];
      const d = new Date();
      const row = document.createElement("div");
      row.className = "mock-row enter-row";
      const amtHtml = amt
        ? `<span class="${cls === "t" ? "t" : cls === "warn" ? "warn" : cls}">${amt}</span>`
        : "<span class=\"t\">—</span>";
      row.innerHTML =
        `<span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span>` +
        `<span>${sym} · ${msg}</span>` + amtHtml;
      feed.prepend(row);
      while (feed.children.length > 4) feed.lastElementChild.remove();

      // Nudge stats from feed events
      if (cls === "ok" && amt && amt.startsWith("+")) {
        const n = parseFloat(amt);
        if (Number.isFinite(n)) {
          state.pnl24 += n * 0.15;
          state.openPnl += n * 0.08;
          state.balance += n * 0.05;
          if (/claim|profit|closed/.test(msg)) state.closes24 += 1;
          flash(p24El, "up");
          flash(openEl, "up");
          flash(balEl, "up");
          renderStats();
        }
      } else if (cls === "acc") {
        state.openCount = Math.min(state.maxSlots, state.openCount + (Math.random() > 0.6 ? 1 : 0));
        renderStats();
      } else if (cls === "bad") {
        state.openCount = Math.max(1, state.openCount - 1);
        state.pnl24 -= 0.012;
        flash(p24El, "down");
        renderStats();
      }
    }, 2200);
  }

  // Heartbeat age — resets when a feed tick lands
  setInterval(() => {
    if (document.hidden) return;
    state.hb = Math.min(24, state.hb + 1);
    if (hbEl) hbEl.textContent = String(state.hb);
  }, 1000);

  setInterval(() => {
    if (document.hidden) return;
    state.hb = 4 + Math.floor(Math.random() * 6);
    // Drift open marks
    state.positions[0].sol = Math.max(28, Math.min(88, state.positions[0].sol + (Math.random() - 0.48) * 14));
    state.positions[0].tick = Math.max(20, Math.min(92, state.positions[0].tick + (Math.random() - 0.5) * 10));
    state.positions[0].pnl += (Math.random() - 0.42) * 0.6;
    state.positions[0].pnl = Math.max(-4, Math.min(12, state.positions[0].pnl));
    state.positions[0].cls = state.positions[0].pnl >= 0 ? "ok" : "bad";
    state.positions[1].sol = Math.max(15, Math.min(65, state.positions[1].sol + (Math.random() - 0.5) * 8));
    state.positions[1].pnl += (Math.random() - 0.55) * 0.4;
    state.openPnl = state.positions.reduce((s, p) => s + p.pnl * 0.012, 0.084);
    renderPositions();
    renderStats();
  }, 3200);

  // Equity spark — new point, chart creeps up on wins
  setInterval(() => {
    if (document.hidden) return;
    const divisor = state.pnl24 > 0.15 ? 0.35 : 0.55;
    const last = state.chartY[state.chartY.length - 1] ?? 20;
    state.chartY.push(Math.max(4, Math.min(30, last + (Math.random() - divisor) * 3)));
    if (state.chartY.length > 14) state.chartY.shift();
    renderSpark();
  }, 2800);

  // Sidebar tab highlight cycle
  if (nav) {
    const tabs = [...nav.querySelectorAll("button")];
    setInterval(() => {
      if (document.hidden) return;
      tabIdx = (tabIdx + 1) % tabs.length;
      tabs.forEach((b, i) => b.classList.toggle("on", i === tabIdx));
      setTimeout(() => {
        tabs.forEach((b, i) => b.classList.toggle("on", i === 0));
      }, 900);
    }, 7000);
  }
}
