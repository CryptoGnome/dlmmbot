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
});
