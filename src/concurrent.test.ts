import { describe, expect, it } from "vitest";
import { mapGrouped } from "./concurrent.js";

/** A deferred whose resolution the test controls. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = () => r(); });
  return { promise, open };
}

describe("mapGrouped", () => {
  it("returns results in input order regardless of completion order", async () => {
    const delays = [30, 0, 15];
    const out = await mapGrouped(
      delays,
      (d) => String(d),
      async (d) => { await new Promise((r) => setTimeout(r, d)); return `done:${d}`; },
      4,
    );
    expect(out.map((r) => r.value)).toEqual(["done:30", "done:0", "done:15"]);
  });

  it("runs different groups concurrently", async () => {
    const g = gate();
    let bStarted = false;
    const run = mapGrouped(
      ["poolA", "poolB"],
      (k) => k,
      async (k) => {
        if (k === "poolA") { await g.promise; return k; }
        bStarted = true;
        return k;
      },
      4,
    );
    // B must be able to start while A is still parked on its gate — that is
    // the entire point of the change.
    await Promise.resolve();
    await Promise.resolve();
    expect(bStarted).toBe(true);
    g.open();
    expect((await run).map((r) => r.value)).toEqual(["poolA", "poolB"]);
  });

  it("never overlaps two items sharing a group key", async () => {
    // The live executor caches one mutable DLMM pool object per address, so
    // same-pool positions overlapping would corrupt each other's state.
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const items = [1, 2, 3, 4];
    await mapGrouped(
      items,
      () => "samePool",
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        order.push(n);
        inFlight--;
        return n;
      },
      4,
    );
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]); // and in the original order
  });

  it("caps how many groups are in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapGrouped(
      [1, 2, 3, 4, 5, 6],
      (n) => String(n),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      2,
    );
    expect(maxInFlight).toBe(2);
  });

  it("treats a limit below 1 as serial rather than deadlocking", async () => {
    let maxInFlight = 0, inFlight = 0;
    const out = await mapGrouped(
      [1, 2, 3],
      (n) => String(n),
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return n;
      },
      0,
    );
    expect(maxInFlight).toBe(1);
    expect(out.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it("captures a throwing item instead of rejecting, and peers still run", async () => {
    const out = await mapGrouped(
      ["ok1", "boom", "ok2"],
      (k) => k,
      async (k) => {
        if (k === "boom") throw new Error("mark failed");
        return k.toUpperCase();
      },
      4,
    );
    expect(out[0]).toMatchObject({ value: "OK1" });
    expect((out[1]!.error as Error).message).toBe("mark failed");
    expect(out[1]!.value).toBeUndefined();
    expect(out[2]).toMatchObject({ value: "OK2" });
  });

  it("does not skip the rest of a group when one of its items throws", async () => {
    const seen: number[] = [];
    const out = await mapGrouped(
      [1, 2, 3],
      () => "same",
      async (n) => { seen.push(n); if (n === 1) throw new Error("first"); return n; },
      4,
    );
    expect(seen).toEqual([1, 2, 3]);
    expect(out.map((r) => r.value)).toEqual([undefined, 2, 3]);
  });

  it("handles an empty input", async () => {
    expect(await mapGrouped([], String, async () => 1, 4)).toEqual([]);
  });
});
