import { describe, it, expect, vi } from "vitest";

/**
 * The mint account read and the largest-holders read need only the mint pubkey
 * and used to run one after the other, so every vetted candidate paid the sum
 * of two RPC round-trips on the entry critical path.
 */
const state = { inFlight: 0, max: 0 };

vi.mock("../rpc.js", () => ({
  makeConnection: () => ({
    async getParsedAccountInfo() {
      return track({
        value: {
          data: {
            program: "spl-token",
            parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, supply: "1000000", decimals: 6 } },
          },
        },
      });
    },
    async getTokenLargestAccounts() {
      return track({ value: [{ address: { toBase58: () => "Acct1" }, amount: "250000" }] });
    },
  }),
}));

async function track<T>(result: T): Promise<T> {
  state.inFlight++;
  state.max = Math.max(state.max, state.inFlight);
  await new Promise((r) => setTimeout(r, 10));
  state.inFlight--;
  return result;
}

const { fetchTokenFacts } = await import("./onchain.js");

describe("fetchTokenFacts", () => {
  it("issues its two independent reads at once", async () => {
    state.inFlight = 0;
    state.max = 0;

    const facts = await fetchTokenFacts("8mCt5QnoD4izGiBncq4C2kkzPDqJNwHY9twnxiAapump");

    expect(state.max).toBe(2); // serial would peak at 1
    expect(facts.mintAuthority).toBeNull();
    expect(facts.supplyRaw).toBe(1_000_000);
    expect(facts.largestAccounts).toEqual([
      { address: "Acct1", amountRaw: 250_000, pctOfSupply: 25 },
    ]);
  });
});
