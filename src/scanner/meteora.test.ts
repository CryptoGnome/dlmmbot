import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchPool, sweepPools, DEFAULT_DATAPI_CONCURRENCY } from "./meteora.js";
import { installConfig, restoreConfig } from "../test/config.js";

/** Minimal shape of what /pools returns; only the fields normalize() reads. */
function rawPool(address: string) {
  return {
    address,
    name: "TST-SOL",
    token_x: { address: "Tok1", symbol: "TST", decimals: 6, holders: 100, freeze_authority_disabled: true, price: 1, market_cap: 1 },
    token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
    created_at: null,
    pool_config: { bin_step: 100, base_fee_pct: 1, collect_fee_mode: 1 },
    dynamic_fee_pct: 0,
    tvl: 50_000,
    current_price: 1,
    volume: {}, fees: {}, fee_tvl_ratio: {},
    is_blacklisted: false,
    launchpad: "pump",
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number) => ({ ok: false, status, body: null });

/** Records call order and peak concurrency across whatever the sweep issues. */
function trackingFetch(handler: (url: string) => Promise<unknown> | unknown, delayMs = 10) {
  const state = { urls: [] as string[], inFlight: 0, max: 0 };
  const fn = vi.fn(async (url: string) => {
    state.urls.push(url);
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inFlight--;
    return handler(url);
  });
  vi.stubGlobal("fetch", fn);
  return state;
}

const pageOf = (url: string) => Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 0);

describe("datapi sweep paging", () => {
  beforeEach(() => {
    installConfig((c) => {
      c.scanner.pages = 5;
      c.scanner.datapi_concurrency = 4;
    });
  });

  afterEach(() => {
    restoreConfig();
    vi.unstubAllGlobals();
  });

  it("fetches page 1 alone, then the rest concurrently", async () => {
    const state = trackingFetch((url) => ok({ data: [rawPool(`P${pageOf(url)}`)], pages: 5 }));

    const pools = await sweepPools();

    expect(state.urls.map(pageOf)).toEqual([1, 2, 3, 4, 5]);
    // Page 1 has to land alone — its `pages` field is what sizes the rest.
    expect(state.max).toBeGreaterThan(1);
    expect(state.max).toBeLessThanOrEqual(4);
    // Serial would have been 5 waves; page 1 plus one wave of 4 is 2.
    expect(pools.map((p) => p.address)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
  });

  it("never requests pages the API says do not exist", async () => {
    const state = trackingFetch((url) => ok({ data: [rawPool(`P${pageOf(url)}`)], pages: 2 }));

    const pools = await sweepPools();

    expect(state.urls.map(pageOf)).toEqual([1, 2]); // configured 5, API has 2
    expect(pools).toHaveLength(2);
  });

  it("honours the concurrency cap", async () => {
    installConfig((c) => { c.scanner.datapi_concurrency = 2; });
    const state = trackingFetch((url) => ok({ data: [rawPool(`P${pageOf(url)}`)], pages: 5 }));

    await sweepPools();

    expect(state.max).toBeLessThanOrEqual(2);
  });

  it("a single-page result issues exactly one request", async () => {
    const state = trackingFetch(() => ok({ data: [rawPool("P1")], pages: 1 }));
    await sweepPools();
    expect(state.urls).toHaveLength(1);
  });

  it("surfaces a failing page rather than returning a short sweep", async () => {
    trackingFetch((url) => (pageOf(url) === 3 ? fail(400) : ok({ data: [rawPool("P")], pages: 5 })));
    await expect(sweepPools()).rejects.toThrow(/HTTP 400/);
  });
});

describe("datapi transient retry", () => {
  beforeEach(() => installConfig(() => {}));
  afterEach(() => {
    restoreConfig();
    vi.unstubAllGlobals();
  });

  it("retries once on a transient status and succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return calls === 1 ? fail(503) : ok(rawPool("Recovered"));
    }));

    const pool = await fetchPool("Recovered");

    expect(calls).toBe(2);
    expect(pool?.address).toBe("Recovered");
  });

  it("retries once on a transport throw", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("fetch failed");
      return ok(rawPool("Recovered"));
    }));

    expect((await fetchPool("Recovered"))?.address).toBe("Recovered");
    expect(calls).toBe(2);
  });

  it("does not retry a 404 — an absent pool is an answer, not a blip", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return fail(404); }));

    expect(await fetchPool("Gone")).toBeNull();
    expect(calls).toBe(1);
  });

  it("gives up after one retry instead of storming a struggling API", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return fail(500); }));

    await expect(fetchPool("Down")).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(2);
  });

  it("defaults the concurrency cap for configs that predate the key", () => {
    expect(DEFAULT_DATAPI_CONCURRENCY).toBe(4);
  });
});
