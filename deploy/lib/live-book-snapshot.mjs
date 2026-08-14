/**
 * Shared live-book snapshot — used by watch-live-book.mjs and dashboard-server.
 * Read-only against farmer.db.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { runtimePaths } from "./runtime-paths.mjs";
import { readDeployPrefs, shouldAutoDeploy } from "./deploy-prefs.mjs";
import { listRecentErrors, errorStats } from "./error-log.mjs";
import {
  decorateWithMeta, loadTokenMetaMap, scheduleTokenMetaBackfill,
} from "./token-meta.mjs";
import { readHaltState } from "./halt.mjs";
import { readPauseState } from "./pause.mjs";
import { readWalletMeta } from "./wallet-crypto.mjs";

const require = createRequire(import.meta.url);

/** Solana pubkeys are base58, 32–44 chars. Reject anything else before use. */
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** First env var whose value is a well-formed base58 pubkey (defense in depth —
 * these are operator-writable via the Settings secrets panel). */
function envPubkey(...names) {
  for (const name of names) {
    const v = (process.env[name] ?? "").trim();
    if (v && BASE58_PUBKEY_RE.test(v)) return v;
  }
  return null;
}

/** Bot trading wallet pubkey for dash header / Solscan links (never the secret). */
export function resolveWalletPubkey() {
  try {
    const metaPk = readWalletMeta()?.publicKey;
    if (metaPk && BASE58_PUBKEY_RE.test(String(metaPk))) return metaPk;
  } catch { /* */ }
  const envPk = envPubkey("WALLET_PUBKEY", "PUBLIC_WALLET");
  if (envPk) return envPk;
  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      const { Keypair } = require("@solana/web3.js");
      const bs58mod = require("bs58");
      const bs58 = bs58mod.default ?? bs58mod;
      return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toBase58();
    } catch { /* */ }
  }
  return null;
}

export const REALIZED_PNL = `
  CASE WHEN close_return_sol IS NOT NULL
       THEN close_return_sol
            + COALESCE(fees_measured_sol, 0)
            + COALESCE(recovered_sol, 0)
            - COALESCE(open_cost_sol, entry_sol + COALESCE(rent_paid_sol, 0))
       WHEN entry_sol > 0
       THEN COALESCE(exit_sol, 0) - entry_sol
            + CASE WHEN COALESCE(fees_measured_sol, 0) > 0
                   THEN fees_measured_sol
                   ELSE COALESCE(fees_claimed_sol, 0) END
            + COALESCE(recovered_sol, 0)
       ELSE 0 END`;

/** Map closed token-account addresses → { mint, symbol } for rent_reclaim rows. */
function buildReclaimAtaIndex(db) {
  const map = new Map();
  try {
    const { Keypair, PublicKey } = require("@solana/web3.js");
    const {
      getAssociatedTokenAddressSync,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    } = require("@solana/spl-token");
    const bs58mod = require("bs58");
    const bs58 = bs58mod.default ?? bs58mod;

    let ownerStr = envPubkey("WALLET_PUBKEY", "PUBLIC_WALLET");
    if (!ownerStr && process.env.WALLET_PRIVATE_KEY) {
      ownerStr = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toBase58();
    }
    if (!ownerStr) return map;
    const owner = new PublicKey(ownerStr);

    const mints = db.prepare(`
      SELECT token_mint AS mint,
             (SELECT p2.symbol FROM positions p2
              WHERE p2.token_mint = p.token_mint AND IFNULL(p2.symbol,'') != ''
              ORDER BY p2.id DESC LIMIT 1) AS symbol
      FROM positions p
      WHERE token_mint IS NOT NULL
      GROUP BY token_mint
    `).all();

    for (const r of mints) {
      if (!r.mint || !r.symbol) continue;
      let mintPk;
      try { mintPk = new PublicKey(r.mint); } catch { continue; }
      for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        for (const off of [false, true]) {
          try {
            map.set(getAssociatedTokenAddressSync(mintPk, owner, off, prog).toBase58(), {
              mint: r.mint,
              symbol: r.symbol,
            });
          } catch { /* */ }
        }
      }
    }
  } catch { /* deps / env missing — leave map empty */ }
  return map;
}

/** Run git with an argv array — no shell, so values can never be interpreted. */
function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitOk(root, args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Branch names come from env — restrict to sane git ref characters (and never a leading "-"). */
export function safeBranch(raw) {
  const b = (raw ?? "").trim();
  return /^[A-Za-z0-9][\w./-]*$/.test(b) ? b : "main";
}

/** Throttle GitHub fetches so the 3s watch loop does not hammer origin. */
let lastOriginFetchAt = 0;
let lastOriginFetchOk = false;
const ORIGIN_FETCH_MS = Number(process.env.DASH_GIT_POLL_MS || 30_000);

/**
 * Local checkout vs origin/$BRANCH (after a throttled fetch).
 * sync: current | behind | ahead | diverged | unknown
 */
function buildGitInfo(root) {
  const branch = safeBranch(process.env.DEPLOY_BRANCH);
  const nowMs = Date.now();
  if (nowMs - lastOriginFetchAt >= ORIGIN_FETCH_MS) {
    lastOriginFetchAt = nowMs;
    lastOriginFetchOk = gitOk(root, ["fetch", "origin", branch, "--quiet"]);
  }

  const headFull = git(root, ["rev-parse", "HEAD"]);
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  const message = git(root, ["log", "-1", "--pretty=%s"]);
  const describe = git(root, ["describe", "--always", "--dirty"]) || head;
  // Ignore untracked clutter from SCP/deploy — only tracked diffs are "dirty".
  const dirty = !!(git(root, ["status", "--porcelain", "--untracked-files=no"]));
  const originFull = git(root, ["rev-parse", `refs/remotes/origin/${branch}`]);
  const origin = originFull
    ? (git(root, ["rev-parse", "--short", `refs/remotes/origin/${branch}`]) || originFull.slice(0, 7))
    : null;

  let sync = "unknown";
  if (headFull && originFull) {
    if (headFull === originFull) sync = "current";
    else if (gitOk(root, ["merge-base", "--is-ancestor", headFull, originFull])) sync = "behind";
    else if (gitOk(root, ["merge-base", "--is-ancestor", originFull, headFull])) sync = "ahead";
    else sync = "diverged";
  }

  let version = "0.0.0";
  let repoUrl = "https://github.com/CryptoGnome/dlmmbot";
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    version = pkg.version || version;
    const raw = pkg.repository?.url ?? pkg.repository;
    if (typeof raw === "string") {
      repoUrl = raw.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
    }
  } catch { /* */ }

  const releaseUrl = `${repoUrl}/releases`;
  const commitsUrl = `${repoUrl}/commits/${branch}`;

  const parseLog = (raw) => {
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const [sha, ts, ...rest] = line.split("\t");
      const subject = rest.join("\t").trim();
      const n = Number(ts);
      return {
        sha: sha || null,
        subject: subject || "(no subject)",
        at: Number.isFinite(n) ? new Date(n * 1000).toISOString() : null,
        ts: Number.isFinite(n) ? n : null,
      };
    }).filter((c) => c.sha);
  };

  /** Classify commit files so Changes can show risk chips for manual approve. */
  function riskTagsForSha(sha) {
    if (!sha || !/^[0-9a-f]{4,40}$/i.test(sha)) return [];
    const files = (git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) || "")
      .split("\n").filter(Boolean);
    const tags = new Set();
    for (const f of files) {
      if (/^dashboard\//.test(f) || /^deploy\/dashboard-server/.test(f)) tags.add("dash");
      else if (/^(docs\/|docs-site\/|llms)/.test(f) || /\.md$/i.test(f)) tags.add("docs");
      else if (/package(-lock)?\.json$/.test(f) || /^dashboard\/package/.test(f)) tags.add("deps");
      else if (/^deploy\//.test(f) || /^\.github\//.test(f) || /^railway/.test(f)) tags.add("deploy");
      else if (
        /^src\/(manager|risk|ranges|scanner|vetting)\//.test(f)
        || f === "STRATEGY.md"
        || f === "config.toml"
        || /^src\/executor\//.test(f)
      ) tags.add("strategy");
      else if (/^src\//.test(f)) tags.add("core");
    }
    const order = ["strategy", "deps", "deploy", "core", "dash", "docs"];
    return order.filter((t) => tags.has(t));
  }

  const recent = parseLog(git(root, ["log", "-20", "--pretty=format:%h%x09%ct%x09%s"]));
  let pending = [];
  let behindCount = 0;
  if (sync === "behind" && originFull) {
    behindCount = Number(git(root, ["rev-list", "--count", `HEAD..${originFull}`])) || 0;
    pending = parseLog(git(root, ["log", `HEAD..${originFull}`, "-20", "--pretty=format:%h%x09%ct%x09%s"]))
      .map((c) => ({ ...c, risk: riskTagsForSha(c.sha) }));
  }

  const prefs = readDeployPrefs(root);
  const gate = sync === "behind" && originFull
    ? shouldAutoDeploy(root, originFull)
    : { ok: true, reason: prefs.autoUpdate ? "auto" : "manual" };
  const needsApproval = sync === "behind" && !prefs.autoUpdate && !gate.ok;

  return {
    version,
    branch,
    head,
    message,
    describe,
    dirty,
    origin,
    sync,
    behind_count: behindCount,
    repo_url: repoUrl,
    release_url: releaseUrl,
    commits_url: commitsUrl,
    fetched_at: lastOriginFetchAt ? Math.floor(lastOriginFetchAt / 1000) : null,
    fetch_ok: lastOriginFetchOk,
    recent,
    pending,
    auto_update: prefs.autoUpdate,
    approve_sha: prefs.approveSha,
    approved_at: prefs.approvedAt,
    needs_approval: needsApproval,
    deploy_gate: gate.reason,
  };
}

function tomlNum(toml, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*([0-9.]+)`, "m").exec(toml);
  return m ? Number(m[1]) : null;
}

function tomlBool(toml, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, "m").exec(toml);
  return m ? m[1] === "true" : null;
}

/** Meteora DLMM portfolio totals — same source as app.meteora.ag/portfolio.
 * Stale-while-revalidate: never block the 3s WS tick on sync curl (was ~5s).
 */
let meteoraCache = { at: 0, wallet: null, data: null, pending: null };
const METEORA_TTL_MS = Number(process.env.DASH_METEORA_TTL_MS || 120_000);

async function fetchMeteoraJson(path) {
  const res = await fetch(`https://dlmm.datapi.meteora.ag${path}`, {
    signal: AbortSignal.timeout(4_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`meteora datapi ${res.status}`);
  return res.json();
}

function fetchMeteoraPortfolio(wallet) {
  // Never build a URL from an unvalidated wallet string (env-writable via Settings).
  if (!wallet || !BASE58_PUBKEY_RE.test(wallet)) return null;
  const now = Date.now();
  const hit = meteoraCache.wallet === wallet ? meteoraCache.data : null;
  const fresh = hit && now - meteoraCache.at < METEORA_TTL_MS;
  if (fresh) return hit;

  if (!meteoraCache.pending || meteoraCache.wallet !== wallet) {
    meteoraCache.wallet = wallet;
    meteoraCache.pending = (async () => {
      try {
        const user = encodeURIComponent(wallet);
        const [total, open] = await Promise.all([
          fetchMeteoraJson(`/portfolio/total?user=${user}`),
          fetchMeteoraJson(`/portfolio/open?user=${user}&page_size=20`),
        ]);
        meteoraCache = {
          at: Date.now(),
          wallet,
          data: {
            closed_n: total.totalClosedPositions ?? null,
            closed_pnl_sol: total.totalPnlSol != null ? Math.round(Number(total.totalPnlSol) * 1e6) / 1e6 : null,
            closed_pct: total.totalPnlSolPctChange != null ? Math.round(Number(total.totalPnlSolPctChange) * 1e4) / 1e4 : null,
            open_n: open.totalPositions ?? open.total?.totalPositions ?? null,
            open_bal_sol: open.total?.balancesSol != null ? Math.round(Number(open.total.balancesSol) * 1e6) / 1e6 : null,
            open_pnl_sol: open.total?.pnlSol != null ? Math.round(Number(open.total.pnlSol) * 1e6) / 1e6 : null,
            source: "dlmm.datapi.meteora.ag",
          },
          pending: null,
        };
      } catch {
        meteoraCache.pending = null;
      }
    })();
  }
  return hit;
}

function openDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  const dbPath = runtimePaths(root).dbPath;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * @param {string} root farmer repo root
 * @returns {object} live watch JSON
 */
export function buildLiveBookSnapshot(root) {
  const db = openDb(root);
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86_400;
    const weekAgo = now - 7 * 86_400;

    const fixSha = git(root, ["rev-parse", "--verify", "1b1514b"]) ? "1b1514b" : null;
    const fixTs = fixSha
      ? Number(git(root, ["show", "-s", "--format=%ct", fixSha])) || (now - 86_400)
      : now - 86_400;

    const toml = readFileSync(runtimePaths(root).configPath, "utf8");
    const gitInfo = buildGitInfo(root);

    const heartbeat = db.prepare("SELECT value FROM meta WHERE key='heartbeat'").get()?.value;
    let hb = null;
    try { hb = heartbeat ? JSON.parse(heartbeat) : null; } catch { /* */ }

    const featStmt = db.prepare(
      `SELECT features_json FROM decisions
       WHERE action='entered' AND mint = ? ORDER BY ts DESC LIMIT 1`
    );
    const sleeveStmt = db.prepare(
      `SELECT json_extract(features_json, '$.sleeve') AS sleeve,
              json_extract(features_json, '$.pool.marketCapUsd') AS mcap,
              json_extract(features_json, '$.follow') AS follow
       FROM decisions
       WHERE mint = ? AND pool = ? AND action = 'entered'
         AND ts BETWEEN ? AND ?
       ORDER BY ABS(ts - ?) LIMIT 1`
    );
    const poolSnapStmt = db.prepare(
      `SELECT tvl_usd, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h, ts
       FROM pool_snapshots WHERE pool = ? ORDER BY ts DESC LIMIT 1`
    );
    const mcapMin = tomlNum(toml, "mcap_min_usd") ?? 50_000;
    const mcapMicroMax = tomlNum(toml, "mcap_micro_max_usd") ?? 200_000;

    function resolveSleeve(row) {
      const entryTs = Number(row.entry_ts) || 0;
      try {
        const hit = sleeveStmt.get(row.mint, row.pool, entryTs - 300, entryTs + 300, entryTs);
        const s = hit?.sleeve;
        if (s === "micro" || s === "majors" || s === "meme") return s;
        if (s === "core") return "meme";
        if (hit?.mcap != null && Number(hit.mcap) >= mcapMin && Number(hit.mcap) < mcapMicroMax) {
          return "micro";
        }
      } catch { /* */ }
      return "meme";
    }

    function priceAtBin(refPrice, refBin, targetBin, binStep) {
      if (!(refPrice > 0) || refBin == null || targetBin == null || !(binStep > 0)) return null;
      return refPrice * Math.pow(1 + binStep / 10_000, targetBin - refBin);
    }

    const open = db.prepare(
      `SELECT p.id, p.symbol, p.token_mint AS mint, p.mode, p.state, p.pool,
              p.entry_ts, p.follow_chain_id,
              round(p.entry_sol,4) entry_sol, round(p.entry_price,12) entry_price,
              round(p.open_cost_sol,6) open_cost_sol,
              p.min_bin_id, p.max_bin_id,
              round(p.fees_claimed_sol,6) fees_claimed_sol,
              datetime(p.entry_ts,'unixepoch') opened,
              m.value_sol, m.value_frac, m.unclaimed_fees_sol, m.in_range,
              m.active_bin_id, m.price AS mark_price, m.ts AS mark_ts,
              datetime(m.ts,'unixepoch') marked
       FROM positions p
       LEFT JOIN position_marks m ON m.id = (
         SELECT id FROM position_marks WHERE position_id = p.id ORDER BY ts DESC LIMIT 1
       )
       WHERE p.state IN ('open','pending','closing')
       ORDER BY p.id`
    ).all().map((r) => {
      let value = r.value_sol != null ? Number(r.value_sol) : null;
      const entry = Number(r.entry_sol) || 0;
      let unclaimed = r.unclaimed_fees_sol != null ? Number(r.unclaimed_fees_sol) : null;
      const claimed = Number(r.fees_claimed_sol) || 0;
      let markUnreliable = false;
      // value_sol=0 with a live price is almost always a failed rebalance / empty
      // SDK read — not a real −100% wipe. Prefer last healthy mark for display.
      if (value === 0 && entry > 0 && r.mark_price != null && Number(r.mark_price) > 0) {
        const prev = db.prepare(
          `SELECT value_sol, value_frac, unclaimed_fees_sol, ts
           FROM position_marks
           WHERE position_id = ? AND value_sol > 0
           ORDER BY ts DESC LIMIT 1`
        ).get(r.id);
        if (prev && Number(prev.value_sol) > 0) {
          value = Number(prev.value_sol);
          unclaimed = prev.unclaimed_fees_sol != null ? Number(prev.unclaimed_fees_sol) : unclaimed;
          markUnreliable = true;
        } else {
          value = null;
          markUnreliable = true;
        }
      }
      const pnl = value != null ? value - entry : null;
      const pct = value != null && entry > 0 ? (value / entry) - 1 : null;
      const liq = value != null
        ? Math.round((value - (unclaimed ?? 0)) * 1e6) / 1e6
        : null;
      const invPnl = liq != null ? Math.round((liq - entry) * 1e6) / 1e6 : null;
      const totalPnl = value != null
        ? Math.round((value - entry + claimed) * 1e6) / 1e6
        : null;
      const minBin = r.min_bin_id;
      const maxBin = r.max_bin_id;
      const activeBin = r.active_bin_id;
      let status = "unknown";
      if (activeBin != null && minBin != null && maxBin != null) {
        if (activeBin > maxBin) status = "above";
        else if (activeBin < minBin) status = "below";
        else status = "in";
      } else if (r.in_range != null) {
        status = r.in_range ? "in" : "out";
      }

      let binStep = 100;
      let sleeve = "meme";
      try {
        sleeve = resolveSleeve(r);
        const feat = featStmt.get(r.mint);
        const j = feat?.features_json ? JSON.parse(feat.features_json) : {};
        if (j.pool?.binStep) binStep = j.pool.binStep;
      } catch { /* */ }

      const markPrice = r.mark_price != null ? Number(r.mark_price) : null;
      const lowPx = priceAtBin(markPrice, activeBin, minBin, binStep);
      const highPx = priceAtBin(markPrice, activeBin, maxBin, binStep);

      let pool = null;
      try {
        const snap = poolSnapStmt.get(r.pool);
        if (snap) {
          const tvl = snap.tvl_usd != null ? Number(snap.tvl_usd) : null;
          const feeTvl24 = snap.fee_tvl_24h != null ? Number(snap.fee_tvl_24h) : null;
          const fees24 = tvl != null && feeTvl24 != null
            ? Math.round(tvl * (feeTvl24 / 100) * 100) / 100
            : null;
          pool = {
            tvl_usd: tvl != null ? Math.round(tvl * 100) / 100 : null,
            vol_30m_usd: snap.vol_30m != null ? Math.round(Number(snap.vol_30m) * 100) / 100 : null,
            vol_1h_usd: snap.vol_1h != null ? Math.round(Number(snap.vol_1h) * 100) / 100 : null,
            vol_24h_usd: snap.vol_24h != null ? Math.round(Number(snap.vol_24h) * 100) / 100 : null,
            fee_tvl_30m_pct: snap.fee_tvl_30m != null ? Math.round(Number(snap.fee_tvl_30m) * 1e4) / 1e4 : null,
            fee_tvl_24h_pct: feeTvl24 != null ? Math.round(feeTvl24 * 1e4) / 1e4 : null,
            /** Pool-wide fees over ~24h from fee/TVL × TVL (Meteora datapi). */
            fees_24h_usd: fees24,
            age_s: snap.ts != null ? now - Number(snap.ts) : null,
          };
        }
      } catch { /* */ }

      return {
        id: r.id,
        symbol: r.symbol,
        mint: r.mint,
        mode: r.mode,
        state: r.state,
        sleeve,
        follow: r.follow_chain_id != null,
        entry_sol: entry,
        entry_price: r.entry_price,
        open_cost_sol: r.open_cost_sol != null ? Number(r.open_cost_sol) : null,
        opened: r.opened,
        fees_claimed_sol: claimed,
        min_bin_id: minBin,
        max_bin_id: maxBin,
        range_status: status,
        pool,
        range: {
          min_bin: minBin,
          max_bin: maxBin,
          active_bin: activeBin,
          min_price: lowPx,
          max_price: highPx,
          price: markPrice,
          status,
        },
        mark: value != null || markUnreliable ? {
          value_sol: value != null ? Math.round(value * 1e6) / 1e6 : null,
          liq_sol: liq,
          pnl_sol: pnl != null ? Math.round(pnl * 1e6) / 1e6 : null,
          inv_pnl_sol: invPnl,
          total_pnl_sol: totalPnl,
          pct: pct != null ? Math.round(pct * 1e6) / 1e6 : null,
          unclaimed_fees_sol: unclaimed != null ? Math.round(unclaimed * 1e6) / 1e6 : null,
          fees_claimed_sol: claimed,
          in_range: status === "in",
          status,
          unreliable: markUnreliable,
          active_bin_id: activeBin,
          price: markPrice,
          age_s: r.mark_ts != null ? now - Number(r.mark_ts) : null,
          at: r.marked,
        } : null,
      };
    });

    const closesSince = (since) => {
      const byReason = db.prepare(
        `SELECT exit_reason,
                COUNT(*) n,
                ROUND(SUM(${REALIZED_PNL}), 6) pnl,
                ROUND(AVG(${REALIZED_PNL}), 6) avg_pnl,
                ROUND(SUM(entry_sol), 6) entry_sol
         FROM positions
         WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts > ?
         GROUP BY exit_reason ORDER BY n DESC`
      ).all(since);
      return byReason.map((r) => ({
        ...r,
        pct: r.entry_sol > 0 ? Math.round((r.pnl / r.entry_sol) * 1e6) / 1e6 : null,
      }));
    };

    const allLiveRow = db.prepare(
      `SELECT COUNT(*) n, ROUND(SUM(${REALIZED_PNL}), 6) pnl, ROUND(SUM(entry_sol), 6) entry_sol
       FROM positions WHERE mode='live' AND exit_ts IS NOT NULL`
    ).get();
    const allLive = {
      ...allLiveRow,
      pct: allLiveRow.entry_sol > 0
        ? Math.round((allLiveRow.pnl / allLiveRow.entry_sol) * 1e6) / 1e6
        : null,
    };

    const kellyRows = db.prepare(
      `SELECT (${REALIZED_PNL}) / entry_sol AS ret
       FROM positions
       WHERE exit_ts IS NOT NULL AND entry_sol > 0 AND follow_chain_id IS NULL
       ORDER BY exit_ts DESC LIMIT 50`
    ).all();

    function kellyFrom(rows) {
      const n = rows.length;
      const minSamples = tomlNum(toml, "kelly_min_samples") ?? 50;
      const frac = tomlNum(toml, "kelly_fraction") ?? 0.5;
      const cold = tomlNum(toml, "kelly_cold_start_frac") ?? 0.02;
      const maxF = tomlNum(toml, "kelly_max_position_frac") ?? 0.05;
      if (n < minSamples) {
        return { samples: n, regime: "cold_start", appliedFraction: cold, fullKelly: null, winRate: null };
      }
      const wins = rows.filter((r) => r.ret > 0).map((r) => r.ret);
      const losses = rows.filter((r) => r.ret <= 0).map((r) => -r.ret);
      const p = wins.length / n;
      const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
      const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
      if (avgLoss === 0) {
        return { samples: n, regime: "kelly", appliedFraction: maxF, fullKelly: null, winRate: p };
      }
      if (avgWin === 0) {
        return { samples: n, regime: "negative_edge", appliedFraction: 0, fullKelly: 0, winRate: p };
      }
      const fullKelly = p - (1 - p) / (avgWin / avgLoss);
      const applied = Math.min(Math.max(fullKelly * frac, 0), maxF);
      return {
        samples: n,
        regime: fullKelly <= 0 ? "negative_edge" : "kelly",
        appliedFraction: applied,
        fullKelly,
        winRate: p,
      };
    }

    const clusterExits = tomlNum(toml, "cluster_brake_exits") ?? 4;
    const clusterWindowH = tomlNum(toml, "cluster_brake_window_h") ?? 6;
    const clusterPauseH = tomlNum(toml, "cluster_brake_pause_h") ?? 2;
    const clusterLossPct = tomlNum(toml, "cluster_brake_loss_pct") ?? 10;
    const clearedRaw = db.prepare(
      "SELECT value FROM meta WHERE key='cluster_brake_cleared_at'"
    ).get()?.value;
    const clearedAt = clearedRaw != null ? Number(clearedRaw) : 0;
    const clusterSince = Math.max(
      now - clusterWindowH * 3600,
      Number.isFinite(clearedAt) ? clearedAt : 0,
    );
    const hard = db.prepare(
      `SELECT exit_ts, exit_reason, symbol
       FROM positions
       WHERE exit_reason IN ('P0_safety','P1_stop') AND exit_ts IS NOT NULL
         AND exit_ts > ?
         AND entry_sol > 0
         AND (${REALIZED_PNL}) / entry_sol <= ?
       ORDER BY exit_ts DESC`
    ).all(clusterSince, -(clusterLossPct / 100));

    let cluster = { tripped: false, count: hard.length, remainingMin: 0, recent: hard.slice(0, 5) };
    if (hard.length >= clusterExits) {
      const tripTs = hard[clusterExits - 1].exit_ts;
      const elapsed = now - tripTs;
      const pauseS = clusterPauseH * 3600;
      if (elapsed < pauseS) {
        cluster = {
          tripped: true,
          count: hard.length,
          remainingMin: Math.ceil((pauseS - elapsed) / 60),
          recent: hard.slice(0, 5),
        };
      }
    }

    const openFailed = db.prepare(
      `SELECT datetime(ts,'unixepoch') at, mint, substr(features_json,1,400) feat
       FROM decisions
       WHERE failed_gate='open_failed' AND ts > ?
       ORDER BY ts DESC LIMIT 20`
    ).all(fixTs);

    function parseOpenFail(feat) {
      try {
        const j = JSON.parse(feat);
        return { code: j.code ?? null, error: (j.error ?? "").slice(0, 120) };
      } catch {
        return { code: null, error: feat.slice(0, 80) };
      }
    }

    const openFailCodes = {};
    for (const r of openFailed) {
      const p = parseOpenFail(r.feat);
      const k = p.code ?? "null";
      openFailCodes[k] = (openFailCodes[k] ?? 0) + 1;
    }

    const markGaps = db.prepare(
      `WITH gaps AS (
         SELECT position_id,
                ts - LAG(ts) OVER (PARTITION BY position_id ORDER BY ts) AS gap
         FROM position_marks
         WHERE ts > ?
       )
       SELECT position_id,
              COUNT(*) n,
              ROUND(AVG(gap),1) mean_gap,
              MAX(gap) max_gap
       FROM gaps WHERE gap IS NOT NULL
       GROUP BY position_id
       HAVING COUNT(*) >= 5
       ORDER BY max_gap DESC
       LIMIT 15`
    ).all(weekAgo);

    const gapFails = markGaps.filter((g) => g.mean_gap < 14 || g.mean_gap > 20 || g.max_gap >= 60);

    const binCoverage = db.prepare(
      `SELECT COUNT(*) closes,
              COALESCE(SUM(CASE WHEN detail_json LIKE '%"bins"%' THEN 1 ELSE 0 END), 0) with_bins
       FROM events
       WHERE type IN ('withdraw','safety_exit') AND ts > ?`
    ).get(fixTs);

    const follow = db.prepare(
      `SELECT state, COUNT(*) n, ROUND(SUM(chain_pnl_sol),4) pnl
       FROM follow_chains WHERE started_ts > ? GROUP BY state`
    ).all(fixTs);

    const p3Missed = db.prepare(
      `SELECT id, symbol, token_mint AS mint, datetime(exit_ts,'unixepoch') at,
              ROUND((${REALIZED_PNL}),4) pnl,
              ROUND(entry_sol, 4) entry_sol,
              ROUND((exit_ts - entry_ts)/60.0,1) hold_min
       FROM positions
       WHERE mode='live' AND exit_reason='P3_above' AND state='closed_missed' AND exit_ts > ?
       ORDER BY exit_ts DESC LIMIT 10`
    ).all(fixTs).map((r) => ({
      ...r,
      pct: r.entry_sol > 0 ? Math.round((r.pnl / r.entry_sol) * 1e6) / 1e6 : null,
    }));

    const BIN_RENT_SCORE_MIN = 70;
    const BIN_RENT_GATES = ["bin_rent", "majors_bin_rent"];

    function parseEntryFeat(feat) {
      try {
        const j = JSON.parse(feat);
        const pool = j.pool ?? {};
        const name = pool.name ?? pool.symbol ?? null;
        return {
          size: typeof j.size === "number" ? Math.round(j.size * 1e4) / 1e4 : null,
          sleeve: j.sleeve ?? (j.follow ? "follow" : null),
          isAlpha: !!j.isAlpha,
          symbol: name ? String(name).split("-")[0] : null,
          baseScore: typeof j.experiment?.baseScore === "number"
            ? Math.round(j.experiment.baseScore * 10) / 10
            : null,
        };
      } catch {
        return {};
      }
    }

    const recentPasses = db.prepare(
      `SELECT datetime(d.ts,'unixepoch') at, d.mint, d.pool, ROUND(d.score,1) score,
              COALESCE(NULLIF(t.symbol,''), NULLIF(
                (SELECT p.symbol FROM positions p WHERE p.token_mint = d.mint ORDER BY p.id DESC LIMIT 1),
                ''), '?') AS symbol,
              json_extract(d.features_json, '$.size') AS size,
              json_extract(d.features_json, '$.sleeve') AS sleeve,
              json_extract(d.features_json, '$.isAlpha') AS is_alpha,
              json_extract(d.features_json, '$.experiment.baseScore') AS base_score,
              json_extract(d.features_json, '$.pool.name') AS pool_name,
              json_extract(d.features_json, '$.follow') AS follow
       FROM decisions d
       LEFT JOIN tokens t ON t.mint = d.mint
       WHERE d.action='entered' AND d.ts > ?
       ORDER BY d.ts DESC
       LIMIT 12`
    ).all(weekAgo).map((r) => {
      const name = r.pool_name ? String(r.pool_name).split("-")[0] : null;
      const size = typeof r.size === "number" ? Math.round(r.size * 1e4) / 1e4 : null;
      const baseScore = typeof r.base_score === "number" ? Math.round(r.base_score * 10) / 10 : null;
      return {
        at: r.at,
        mint: r.mint || null,
        pool: r.pool || null,
        score: r.score,
        size,
        sleeve: r.sleeve || (r.follow ? "follow" : null),
        isAlpha: !!r.is_alpha,
        baseScore,
        symbol: r.symbol && r.symbol !== "?" ? r.symbol : (name || "?"),
      };
    });

    // Unified ops timeline for Activity + Overview preview (signal, not fee-gate noise).
    const INTERESTING_SKIP = new Set([
      "open_failed", "majors_open_failed", "tranche_open_failed",
      "bin_rent", "majors_bin_rent", "size_zero", "already_positioned",
      "slots_full", "follow_active", "reentry_limit", "insider_clusters",
      "majors_rsi_warmup", "majors_swing_high", "majors_entry_timing",
      "majors_fee_tvl_30m", "majors_token_open", "majors_deploy_cap",
      "majors_pool_share", "micro_score", "micro_tvl", "micro_slots_full",
      "age_min", "age_max", "displaced",
    ]);
    const activitySince = now - 24 * 3600;
    let recentActivity = [];
    try {
    const activity = [];
    /** Lazily built once if any legacy rent_reclaim needs ATA→ticker resolution. */
    let ataIndex = null;

    for (const r of db.prepare(
      `SELECT d.ts, datetime(d.ts,'unixepoch') at, d.mint, d.pool, ROUND(d.score,1) score,
              json_extract(d.features_json,'$.size') size,
              json_extract(d.features_json,'$.sleeve') sleeve,
              json_extract(d.features_json,'$.isAlpha') is_alpha,
              json_extract(d.features_json,'$.pool.name') pool_name,
              json_extract(d.features_json,'$.tranche') tranche,
              COALESCE(
                NULLIF(t.symbol,''),
                NULLIF(json_extract(d.features_json,'$.symbol'),''),
                NULLIF(json_extract(d.features_json,'$.cand.symbol'),''),
                (SELECT p.symbol FROM positions p WHERE p.token_mint=d.mint ORDER BY p.id DESC LIMIT 1),
                NULL
              ) symbol,
              (
                SELECT COALESCE(NULLIF(e.tx_sig,''), json_extract(e.detail_json,'$.sigs[0]'))
                FROM events e
                JOIN positions p ON p.id = e.position_id
                WHERE e.type = 'open'
                  AND p.token_mint = d.mint
                  AND e.ts BETWEEN d.ts - 30 AND d.ts + 600
                  AND COALESCE(NULLIF(e.tx_sig,''), json_extract(e.detail_json,'$.sigs[0]')) IS NOT NULL
                ORDER BY e.ts DESC
                LIMIT 1
              ) AS tx_sig
       FROM decisions d LEFT JOIN tokens t ON t.mint=d.mint
       WHERE d.action='entered' AND d.ts > ?
       ORDER BY d.ts DESC LIMIT 40`
    ).all(activitySince)) {
      const sym = r.symbol || (r.pool_name ? String(r.pool_name).split("-")[0] : null) || (r.mint ? String(r.mint).slice(0, 6) : "?");
      activity.push({
        ts: r.ts, at: r.at, kind: "entry",
        symbol: sym, mint: r.mint || null, pool: r.pool || null,
        score: r.score, size: typeof r.size === "number" ? Math.round(r.size * 1e4) / 1e4 : null,
        sleeve: r.sleeve || null, gate: null, pnl: null, detail: r.tranche ? "tranche" : (r.is_alpha ? "alpha" : null),
        tx_sig: r.tx_sig || null,
      });
    }

    for (const r of db.prepare(
      `SELECT exit_ts AS ts, datetime(exit_ts,'unixepoch') at, id, symbol, token_mint AS mint, pool,
              exit_reason AS gate, ROUND(entry_sol,4) entry_sol,
              ROUND((${REALIZED_PNL}),6) pnl, ROUND((exit_ts-entry_ts)/60.0,1) hold_min,
              ROUND(COALESCE(fees_measured_sol, 0) + COALESCE(fees_at_close_sol, 0), 6) fee_total,
              tranche_of,
              (
                SELECT COALESCE(NULLIF(e.tx_sig,''), json_extract(e.detail_json,'$.sigs[0]'))
                FROM events e
                WHERE e.position_id = positions.id
                  AND e.type IN ('withdraw','safety_exit','force_close')
                  AND COALESCE(NULLIF(e.tx_sig,''), json_extract(e.detail_json,'$.sigs[0]')) IS NOT NULL
                ORDER BY e.ts DESC LIMIT 1
              ) AS tx_sig
       FROM positions
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts > ?
       ORDER BY exit_ts DESC LIMIT 40`
    ).all(activitySince)) {
      activity.push({
        ts: r.ts, at: r.at, kind: "exit",
        symbol: r.symbol || "?", mint: r.mint || null, pool: r.pool || null,
        score: null, size: r.entry_sol, sleeve: null, gate: r.gate,
        pnl: r.pnl, detail: [
          r.hold_min != null ? `${r.hold_min}m` : null,
          r.fee_total > 0 && Math.abs(r.pnl) < 0.0001 ? `fees ${r.fee_total}` : null,
          r.tranche_of != null ? `tranche of #${r.tranche_of}` : `#${r.id}`,
        ].filter(Boolean).join(" · ") || null,
        tx_sig: r.tx_sig || null,
      });
    }

    for (const r of db.prepare(
      `SELECT d.ts, datetime(d.ts,'unixepoch') at, d.mint, d.pool, d.failed_gate gate,
              ROUND(d.score,1) score,
              json_extract(d.features_json,'$.sleeve') sleeve,
              json_extract(d.features_json,'$.pool.name') pool_name,
              json_extract(d.features_json,'$.size') size,
              json_extract(d.features_json,'$.error') error,
              COALESCE(
                NULLIF(t.symbol,''),
                NULLIF(json_extract(d.features_json,'$.symbol'),''),
                NULLIF(json_extract(d.features_json,'$.cand.symbol'),''),
                (SELECT p.symbol FROM positions p WHERE p.token_mint=d.mint ORDER BY p.id DESC LIMIT 1),
                NULL
              ) symbol
       FROM decisions d LEFT JOIN tokens t ON t.mint=d.mint
       WHERE d.action='skipped' AND d.ts > ?
         AND (
           d.failed_gate IN (${[...INTERESTING_SKIP].map(() => "?").join(",")})
           OR (d.score IS NOT NULL AND d.score >= 85)
         )
       ORDER BY d.ts DESC LIMIT 120`
    ).all(activitySince, ...INTERESTING_SKIP)) {
      const sym = r.symbol || (r.pool_name ? String(r.pool_name).split("-")[0] : null) || (r.mint ? String(r.mint).slice(0, 6) : "?");
      const isFail = /open_failed/.test(r.gate || "");
      activity.push({
        ts: r.ts, at: r.at, kind: isFail ? "fail" : "skip",
        symbol: sym, mint: r.mint || null, pool: r.pool || null,
        score: r.score, size: typeof r.size === "number" ? Math.round(r.size * 1e4) / 1e4 : null,
        sleeve: r.sleeve || null, gate: r.gate, pnl: null,
        detail: r.error ? String(r.error).slice(0, 100) : null,
      });
    }

    for (const r of db.prepare(
      `SELECT e.ts, datetime(e.ts,'unixepoch') at, e.type, e.position_id, e.detail_json, e.tx_sig,
              ROUND(e.sol_delta,4) sol_delta, p.symbol, p.token_mint AS mint, p.pool
       FROM events e
       LEFT JOIN positions p ON p.id = e.position_id
       WHERE e.ts > ?
         AND e.type IN ('claim','profit_lock','rebalance','rebalance_partial','rent_reclaim','force_close')
       ORDER BY e.ts DESC LIMIT 30`
    ).all(activitySince)) {
      let symbol = r.symbol || null;
      let mint = r.mint || null;
      let detailExtra = null;
      let txSig = r.tx_sig || null;
      try {
        const j = r.detail_json ? JSON.parse(r.detail_json) : null;
        if (!txSig && Array.isArray(j?.sigs) && typeof j.sigs[0] === "string") txSig = j.sigs[0];
        const tokens = Array.isArray(j?.tokens) ? j.tokens : null;
        if (tokens?.length) {
          const syms = [...new Set(tokens.map((t) => t?.symbol).filter(Boolean))];
          const mints = [...new Set(tokens.map((t) => t?.mint).filter(Boolean))];
          if (!symbol && syms.length) symbol = syms.join("+");
          if (!mint && mints.length === 1) mint = mints[0];
          if (tokens.length > 1) detailExtra = `${tokens.length} accounts`;
        } else if (!symbol && (j?.symbol || j?.mint)) {
          symbol = j.symbol || String(j.mint).slice(0, 8);
          mint = mint || j.mint || null;
        } else if (!symbol && Array.isArray(j?.accounts) && j.accounts.length) {
          // Legacy rent_reclaim rows only stored ATA pubkeys — map back via known positions.
          if (!ataIndex) ataIndex = buildReclaimAtaIndex(db);
          const hits = j.accounts.map((a) => ataIndex.get(a)).filter(Boolean);
          if (hits.length) {
            symbol = [...new Set(hits.map((h) => h.symbol))].join("+");
            if (hits.length === 1) mint = hits[0].mint;
            if (hits.length > 1) detailExtra = `${hits.length} accounts`;
          }
        }
      } catch { /* */ }
      if (!symbol && mint) {
        const tok = db.prepare("SELECT symbol FROM tokens WHERE mint = ?").get(mint);
        symbol = tok?.symbol || mint.slice(0, 8);
      }
      activity.push({
        ts: r.ts, at: r.at, kind: "event",
        symbol: symbol || "?",
        mint, pool: r.pool || null,
        score: null, size: r.sol_delta, sleeve: null, gate: r.type, pnl: r.sol_delta,
        detail: [
          r.position_id != null ? `#${r.position_id}` : null,
          detailExtra,
        ].filter(Boolean).join(" · ") || null,
        tx_sig: txSig || null,
      });
    }

    activity.sort((a, b) => b.ts - a.ts);
    // Collapse skip spam: keep newest per mint+gate (still show every entry/exit/event/fail).
    const seenSkip = new Set();
    const deduped = [];
    for (const a of activity) {
      if (a.kind === "skip") {
        const k = `${a.mint ?? a.symbol}|${a.gate}`;
        if (seenSkip.has(k)) continue;
        seenSkip.add(k);
      }
      deduped.push(a);
      if (deduped.length >= 80) break;
    }
    const recentActivityBuilt = deduped.map(({ ts: _ts, ...rest }) => rest);
    recentActivity = recentActivityBuilt;
    } catch (e) {
      console.error("[live-book] recent_activity failed:", e?.message ?? e);
      recentActivity = [];
    }

    function parseBinRentNearMiss(feat) {
      try {
        const j = JSON.parse(feat);
        const range = j.range ?? {};
        const pool = j.pool ?? j.cand?.pool ?? {};
        return {
          symbol: pool.symbol ?? pool.name?.split("-")[0] ?? null,
          pool: pool.address ?? j.poolAddress ?? null,
          estRentSol: range.estBinRentSol ?? null,
          binCount: range.binCount ?? null,
          bottomPct: range.bottomPricePct ?? null,
          rentBudget: j.rentBudget ?? null,
          sleeve: j.sleeve ?? null,
        };
      } catch {
        return {};
      }
    }

    function binRentNearMiss(since) {
      const gates = BIN_RENT_GATES.map(() => "?").join(",");
      const byGate = db.prepare(
        `SELECT failed_gate g, COUNT(*) n
         FROM decisions
         WHERE action='skipped' AND failed_gate IN (${gates}) AND score >= ? AND ts > ?
         GROUP BY failed_gate ORDER BY n DESC`
      ).all(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const n = byGate.reduce((s, r) => s + r.n, 0);
      const recent = db.prepare(
        `SELECT datetime(d.ts,'unixepoch') at, d.mint, d.pool, d.failed_gate g, ROUND(d.score,1) score,
                COALESCE(NULLIF(t.symbol,''), NULLIF(
                  (SELECT p.symbol FROM positions p WHERE p.token_mint = d.mint ORDER BY p.id DESC LIMIT 1),
                  ''), '?') AS symbol,
                substr(d.features_json,1,500) feat
         FROM decisions d
         LEFT JOIN tokens t ON t.mint = d.mint
         WHERE d.action='skipped' AND d.failed_gate IN (${gates}) AND d.score >= ? AND d.ts > ?
         ORDER BY d.ts DESC LIMIT 8`
      ).all(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const best = db.prepare(
        `SELECT datetime(d.ts,'unixepoch') at, d.mint, d.pool, d.failed_gate g, ROUND(d.score,1) score,
                COALESCE(NULLIF(t.symbol,''), NULLIF(
                  (SELECT p.symbol FROM positions p WHERE p.token_mint = d.mint ORDER BY p.id DESC LIMIT 1),
                  ''), '?') AS symbol,
                substr(d.features_json,1,500) feat
         FROM decisions d
         LEFT JOIN tokens t ON t.mint = d.mint
         WHERE d.action='skipped' AND d.failed_gate IN (${gates}) AND d.score >= ? AND d.ts > ?
         ORDER BY d.score DESC LIMIT 1`
      ).get(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const mapRow = (r) => {
        if (!r) return null;
        const feat = parseBinRentNearMiss(r.feat);
        return {
          at: r.at,
          mint: r.mint || null,
          pool: r.pool || feat.pool || null,
          gate: r.g,
          score: r.score,
          ...feat,
          symbol: r.symbol || feat.symbol || "?",
        };
      };
      return { n, score_min: BIN_RENT_SCORE_MIN, by_gate: byGate, best: mapRow(best),
        recent: recent.map(mapRow) };
    }

    const sinceFix = closesSince(fixTs);
    const last24 = closesSince(dayAgo);
    const bookAgg = (rows) => {
      const n = rows.reduce((s, r) => s + r.n, 0);
      const pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
      const entry_sol = rows.reduce((s, r) => s + (r.entry_sol ?? 0), 0);
      return {
        by_reason: rows,
        n,
        pnl,
        entry_sol,
        pct: entry_sol > 0 ? Math.round((pnl / entry_sol) * 1e6) / 1e6 : null,
      };
    };

    const deployedSol = open.reduce((s, p) => {
      const mark = p.mark?.value_sol;
      return s + (typeof mark === "number" && Number.isFinite(mark) ? mark : (p.entry_sol ?? 0));
    }, 0);
    const walletSol = typeof hb?.walletSol === "number" ? hb.walletSol : null;
    const solUsdRow = db.prepare(
      `SELECT sol_usd FROM pnl_daily WHERE mode='live' AND sol_usd > 0 ORDER BY day DESC LIMIT 1`
    ).get();
    const solUsd = solUsdRow?.sol_usd ?? null;
    const totalSol = walletSol != null ? walletSol + deployedSol : null;
    const balance = {
      wallet_sol: walletSol != null ? Math.round(walletSol * 1e6) / 1e6 : null,
      deployed_sol: Math.round(deployedSol * 1e6) / 1e6,
      total_sol: totalSol != null ? Math.round(totalSol * 1e6) / 1e6 : null,
      sol_usd: solUsd,
      total_usd: totalSol != null && solUsd
        ? Math.round(totalSol * solUsd * 100) / 100
        : null,
      wallet_usd: walletSol != null && solUsd
        ? Math.round(walletSol * solUsd * 100) / 100
        : null,
    };

    const walletPubkey = resolveWalletPubkey();
    // Meteora Data API — LP deposit/withdraw/fee PnL (what app.meteora.ag/portfolio shows).
    // Distinct from our wallet-measured book (includes rent + post-exit swap slippage).
    const meteora = fetchMeteoraPortfolio(walletPubkey);

    const recentErrors = listRecentErrors(db, 80);
    const metaMints = [
      ...open.map((r) => r.mint),
      ...recentActivity.map((r) => r.mint),
      ...recentPasses.map((r) => r.mint),
      ...p3Missed.map((r) => r.mint),
      ...recentErrors.map((r) => r.mint),
    ].filter(Boolean);
    const tokenMeta = loadTokenMetaMap(db, metaMints);
    decorateWithMeta(open, tokenMeta);
    decorateWithMeta(recentActivity, tokenMeta);
    decorateWithMeta(recentPasses, tokenMeta);
    decorateWithMeta(p3Missed, tokenMeta);
    decorateWithMeta(recentErrors, tokenMeta);
    scheduleTokenMetaBackfill(root, metaMints);
    const halt = readHaltState(root);
    const pause = readPauseState(root);

    return {
      ts: now,
      at: new Date(now * 1000).toISOString(),
      host: (() => { try { return hostname() || "local"; } catch { return "local"; } })(),
      wallet_pubkey: walletPubkey,
      ops: {
        paused: pause.paused,
        pause_at: pause.pause_at,
        halted: halt.halted,
        halt_at: halt.halt_at,
      },
      build: {
        version: gitInfo.version,
        branch: gitInfo.branch,
        head: gitInfo.head,
        message: gitInfo.message,
        describe: gitInfo.describe,
        dirty: gitInfo.dirty,
        origin: gitInfo.origin,
        sync: gitInfo.sync,
        behind_count: gitInfo.behind_count,
        repo_url: gitInfo.repo_url,
        release_url: gitInfo.release_url,
        commits_url: gitInfo.commits_url,
        running: hb?.build ?? null,
        fetched_at: gitInfo.fetched_at,
        recent: gitInfo.recent,
        pending: gitInfo.pending,
        auto_update: gitInfo.auto_update,
        approve_sha: gitInfo.approve_sha,
        approved_at: gitInfo.approved_at,
        needs_approval: gitInfo.needs_approval,
        deploy_gate: gitInfo.deploy_gate,
        fix_sha: fixSha,
        fix_ts: fixTs,
        fix_at: new Date(fixTs * 1000).toISOString(),
      },
      config: {
        liquidity_slippage_pct: tomlNum(toml, "liquidity_slippage_pct"),
        above_range_sustain_min: tomlNum(toml, "above_range_sustain_min"),
        above_range_missed_sustain_min: tomlNum(toml, "above_range_missed_sustain_min"),
        cluster_brake_exits: clusterExits,
        cluster_brake_window_h: clusterWindowH,
        cluster_brake_pause_h: clusterPauseH,
        cluster_brake_loss_pct: clusterLossPct,
        open_fail_cooldown_s: tomlNum(toml, "open_fail_cooldown_s"),
        kelly_enabled: tomlBool(toml, "kelly_enabled"),
        sizing_mode: (() => {
          const m = new RegExp(`^\\s*mode\\s*=\\s*"?(kelly|fixed)"?`, "m").exec(toml);
          if (m) return m[1];
          return tomlBool(toml, "kelly_enabled") === false ? "fixed" : "kelly";
        })(),
        kelly_min_samples: tomlNum(toml, "kelly_min_samples"),
        max_positions: tomlNum(toml, "max_positions"),
        stop_loss_frac: tomlNum(toml, "stop_loss_frac"),
      },
      heartbeat: hb,
      heartbeat_age_s: hb?.ts ? now - hb.ts : null,
      balance,
      meteora,
      open,
      book: {
        all_time_live: allLive,
        since_fix: bookAgg(sinceFix),
        last_24h: bookAgg(last24),
      },
      kelly: kellyFrom(kellyRows),
      cluster,
      open_failed_since_fix: {
        n: openFailed.length,
        by_code: openFailCodes,
        recent: openFailed.slice(0, 5).map((r) => ({
          at: r.at, mint: r.mint, ...parseOpenFail(r.feat),
        })),
      },
      integrity: {
        mark_gaps: {
          positions_checked: markGaps.length,
          fail_count: gapFails.length,
          pass: gapFails.length === 0 && markGaps.length > 0,
          worst: markGaps.slice(0, 5),
          fails: gapFails.slice(0, 5),
        },
        per_bin_closes: binCoverage,
      },
      follow_since_fix: follow,
      p3_missed_since_fix: p3Missed,
      bin_rent_near_miss: {
        since_fix: binRentNearMiss(fixTs),
        last_24h: binRentNearMiss(dayAgo),
      },
      recent_passes: recentPasses,
      recent_activity: recentActivity,
      recent_errors: recentErrors,
      error_stats: errorStats(db, now),
      token_meta: tokenMeta,
    };
  } finally {
    db.close();
  }
}
