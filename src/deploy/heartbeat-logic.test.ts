import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const { evaluateHeartbeat, shouldAlert, STALE_S, REMIND_S } = require("../../deploy/heartbeat-logic.cjs") as {
  evaluateHeartbeat: (hb: unknown, nowS: number, staleS?: number) => {
    status: "ok" | "stale" | "missing";
    age: number | null;
    message: string | null;
  };
  shouldAlert: (nowS: number, lastAlertS: number, remindS?: number) => boolean;
  STALE_S: number;
  REMIND_S: number;
};

describe("heartbeat-logic", () => {
  const now = 1_700_000_000;

  it("flags missing heartbeat", () => {
    const r = evaluateHeartbeat(null, now);
    expect(r.status).toBe("missing");
    expect(r.message).toMatch(/no heartbeat row/);
  });

  it("flags stale heartbeat past STALE_S", () => {
    const r = evaluateHeartbeat({ ts: now - STALE_S - 1, pid: 1, build: "abc", open: 2 }, now);
    expect(r.status).toBe("stale");
    expect(r.age).toBe(STALE_S + 1);
    expect(r.message).toMatch(/stale/);
    expect(r.message).toMatch(/2 position/);
  });

  it("accepts a fresh heartbeat", () => {
    const r = evaluateHeartbeat({ ts: now - 30, pid: 9, build: "deadbeef", open: 0 }, now);
    expect(r.status).toBe("ok");
    expect(r.age).toBe(30);
    expect(r.message).toBeNull();
  });

  it("shouldAlert respects remind window", () => {
    expect(shouldAlert(now, 0)).toBe(true);
    expect(shouldAlert(now, now - REMIND_S + 1)).toBe(false);
    expect(shouldAlert(now, now - REMIND_S)).toBe(true);
  });
});
