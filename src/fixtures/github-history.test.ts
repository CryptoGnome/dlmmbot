// @ts-nocheck — imports deploy/*.mjs (no TS declarations)
import { describe, expect, it } from "vitest";
import {
  normalizeGithubCommit,
  riskTagsFromPaths,
} from "../../deploy/lib/github-history.mjs";

describe("github-history", () => {
  it("maps changed paths to Changes risk chips", () => {
    expect(riskTagsFromPaths(["src/manager/loop.ts", "config.toml"])).toEqual([
      "strategy",
    ]);
    expect(riskTagsFromPaths(["dashboard/src/pages/Changelog.tsx"])).toContain("dash");
    expect(riskTagsFromPaths(["package.json", "deploy/start.sh"])).toEqual([
      "deps",
      "deploy",
    ]);
  });

  it("normalizes a GitHub commit payload", () => {
    const c = normalizeGithubCommit({
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      commit: {
        message: "fix railway changelog\n\nbody",
        committer: { date: "2026-08-14T12:00:00Z" },
      },
      files: [{ filename: "deploy/lib/live-book-snapshot.mjs" }],
    });
    expect(c.sha).toBe("abcdef0");
    expect(c.subject).toBe("fix railway changelog");
    expect(c.risk).toContain("deploy");
    expect(c.ts).toBe(Math.floor(Date.parse("2026-08-14T12:00:00Z") / 1000));
  });

  it("uses merge PR body line as subject", () => {
    const c = normalizeGithubCommit({
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      commit: {
        message: "Merge pull request #61 from x/release/v0.3.12\n\nRelease v0.3.12 — SIGTERM exit 0",
        committer: { date: "2026-08-14T12:00:00Z" },
      },
    });
    expect(c.subject).toBe("Release v0.3.12 — SIGTERM exit 0");
  });
});
