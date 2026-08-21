import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vetToken } from "./vet.js";
import { fetchTokenFacts } from "./onchain.js";
import { fetchReport } from "./rugcheck.js";
import { tokenSecurity } from "../scanner/gmgn.js";
import { jupAsset } from "./jupdata.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";

vi.mock("./onchain.js", () => ({ fetchTokenFacts: vi.fn() }));
vi.mock("./rugcheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rugcheck.js")>()),
  fetchReport: vi.fn(async () => null),
}));
vi.mock("./jupdata.js", () => ({ jupAsset: vi.fn() }));
vi.mock("../scanner/gmgn.js", () => ({
  tokenSecurity: vi.fn(),
  tokenTraderTags: vi.fn(async () => null),
}));

const MINT = "Tok1111111111111111111111111111111111111";

/**
 * Jupiter and GMGN are different hosts behind different limiters, and neither
 * gates the other — but the Jupiter call was awaited behind both GMGN calls, so
 * a vet paid GMGN + Jupiter instead of the slower of the two.
 */
describe("vetToken external-call overlap", () => {
  const state = { inFlight: 0, max: 0 };

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.vetting.gmgn_trader_tags_enabled = false;
      c.vetting.holder_gate_enabled = false;
    });
    state.inFlight = 0;
    state.max = 0;

    const slow = async <T>(result: T): Promise<T> => {
      state.inFlight++;
      state.max = Math.max(state.max, state.inFlight);
      await new Promise((r) => setTimeout(r, 15));
      state.inFlight--;
      return result;
    };

    vi.mocked(fetchTokenFacts).mockResolvedValue({
      mintAuthority: null, freezeAuthority: null, tokenProgram: "spl-token",
      token2022Extensions: [], supplyRaw: 1e9, decimals: 6, largestAccounts: [],
    });
    vi.mocked(fetchReport).mockResolvedValue(null);
    vi.mocked(tokenSecurity).mockImplementation(() => slow(null));
    vi.mocked(jupAsset).mockImplementation(() => slow(null));
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("asks Jupiter and GMGN at the same time", async () => {
    await vetToken(MINT, Date.now() - 3 * 3600_000);

    expect(state.max).toBe(2); // queued behind each other would peak at 1
    expect(vi.mocked(jupAsset)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tokenSecurity)).toHaveBeenCalledTimes(1);
  });
});
