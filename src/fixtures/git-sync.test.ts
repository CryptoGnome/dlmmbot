import { describe, it, expect } from "vitest";
// @ts-expect-error deploy/*.mjs sits outside src rootDir — no ambient types
import { envCommitSha, shortSha, shasMatch, syncFromShas } from "../../deploy/lib/live-book-snapshot.mjs";

describe("build pill SHA helpers (Railway fallback)", () => {
  it("reads RAILWAY_GIT_COMMIT_SHA", () => {
    const prev = process.env.RAILWAY_GIT_COMMIT_SHA;
    process.env.RAILWAY_GIT_COMMIT_SHA = "abcdef0123456789";
    expect(envCommitSha()).toBe("abcdef0123456789");
    expect(shortSha(envCommitSha()!)).toBe("abcdef0");
    if (prev === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = prev;
  });

  it("matches abbreviated vs full SHAs", () => {
    expect(shasMatch("deadbeef", "deadbeefcafebabe")).toBe(true);
    expect(shasMatch("deadbeefcafebabe", "deadbeef")).toBe(true);
    expect(shasMatch("aaaaaaaa", "bbbbbbbb")).toBe(false);
  });

  it("syncFromShas is current or behind without local git", () => {
    expect(syncFromShas("abc1234", "abc1234ffff")).toBe("current");
    expect(syncFromShas("abc1234", "def5678")).toBe("behind");
    expect(syncFromShas(null, "abc")).toBe("unknown");
  });
});
