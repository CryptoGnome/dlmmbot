import { describe, expect, it } from "vitest";
import { presentError } from "./present.js";

describe("presentError", () => {
  it("labels Meteora scan timeouts as transient warnings", () => {
    const p = presentError({
      source: "scanner",
      code: "sweep_failed",
      message: "The operation was aborted due to timeout",
      stack: "at async getJson (/src/scanner/meteora.ts:45:15)",
    });
    expect(p.kind).toBe("transient");
    expect(p.level).toBe("warn");
    expect(p.label).toBe("Pool scan timed out");
  });

  it("keeps open failures as incidents", () => {
    const p = presentError({
      source: "enter",
      code: "open_failed",
      message: "Simulation failed",
    });
    expect(p.kind).toBe("incident");
    expect(p.label).toContain("Entry");
  });

  /**
   * 2026-08-18: three consecutive close_underfilled reports (BUTTHOLE, Z500,
   * 67coin) were 1–2% slivers — fee accrual on winning P3 closes — that the
   * sweep sold within minutes. The executor now sets the level from the
   * leftover's share of the mark; presentation must follow it so a sliver is
   * neither counted as an incident nor forwarded as a report.
   */
  it("close_underfilled at warn is a transient sliver, not an incident", () => {
    const p = presentError({
      source: "live",
      code: "close_underfilled",
      level: "warn",
      message: "[live] pos#112 67coin: close left 351283883 raw tokens in wallet (~0.0098 SOL, 2% of mark) — sliver; residual sweep will sell it.",
    });
    expect(p.kind).toBe("transient");
    expect(p.level).toBe("warn");
    expect(p.label).toBe("Exit swap left a sliver");
  });

  it("close_underfilled at error stays an incident", () => {
    const p = presentError({
      source: "live",
      code: "close_underfilled",
      level: "error",
      message: "[live] pos#8 ANSEM: close left 1 raw tokens in wallet (~0.4 SOL, 75% of mark) — swap under-filled; residual sweep will sell it. Position is NOT fully out.",
    });
    expect(p.kind).toBe("incident");
    expect(p.level).toBe("error");
    expect(p.label).toBe("Exit swap under-filled");
  });

  it("close_underfilled with no level (older callers) is still an incident", () => {
    const p = presentError({ source: "live", code: "close_underfilled", message: "x" });
    expect(p.kind).toBe("incident");
  });

  it("escalates repeated RPC probe failures", () => {
    const p = presentError({
      source: "watchdog",
      code: "rpc_probe",
      level: "error",
      message: "429 Too Many Requests",
    });
    expect(p.label).toBe("RPC offline");
    expect(p.kind).toBe("incident");
  });

  it("labels GMGN rate limits as degraded", () => {
    const p = presentError({
      source: "gmgn",
      code: "rate_limit",
      level: "warn",
      message: "GMGN rate limited — trending/vetting paused until reset",
    });
    expect(p.kind).toBe("degraded");
    expect(p.label).toBe("GMGN rate limited");
  });
});
