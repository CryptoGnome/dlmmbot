// @ts-nocheck — imports deploy/*.mjs (no TS declarations)
import { describe, expect, it } from "vitest";
import {
  labelCommits,
  normalizeGithubRelease,
  operatorCommitLabel,
  subjectFromCommitMessage,
  summarizeReleaseBody,
} from "../../deploy/lib/release-labels.mjs";
import { normalizeGithubCommit } from "../../deploy/lib/github-history.mjs";

describe("release-labels", () => {
  const releases = [
    {
      tag: "v0.3.12",
      name: "DLMM Bot v0.3.12",
      summary: "Exit 0 on Railway SIGTERM so redeploys are not reported as crashes",
    },
  ];

  it("summarizes release body bullets", () => {
    expect(summarizeReleaseBody("## What's Changed\n\n- Fix A\n- Fix B\n\n**Full Changelog**: x"))
      .toBe("Fix A · Fix B");
  });

  it("uses merge-commit body as subject", () => {
    expect(subjectFromCommitMessage(
      "Merge pull request #61 from CryptoGnome/release/v0.3.12\n\nRelease v0.3.12",
    )).toBe("Release v0.3.12");
  });

  it("rewrites bare release / merge-release subjects with notes", () => {
    expect(operatorCommitLabel("Release v0.3.12", releases))
      .toContain("Exit 0 on Railway");
    expect(operatorCommitLabel(
      "Merge pull request #61 from CryptoGnome/release/v0.3.12",
      releases,
    )).toMatch(/^v0\.3\.12 —/);
  });

  it("keeps inline release one-liners", () => {
    expect(operatorCommitLabel("Release v0.3.13 — clearer Changes tab", []))
      .toBe("v0.3.13 — clearer Changes tab");
  });

  it("normalizes a GitHub release payload", () => {
    const r = normalizeGithubRelease({
      tag_name: "v0.3.12",
      name: "DLMM Bot v0.3.12",
      body: "- Exit 0 on Railway redeploy SIGTERM\n",
      published_at: "2026-08-14T22:00:00Z",
      html_url: "https://github.com/CryptoGnome/dlmmbot/releases/tag/v0.3.12",
    });
    expect(r?.tag).toBe("v0.3.12");
    expect(r?.summary).toMatch(/Exit 0/);
  });

  it("labels commit rows in place", () => {
    const out = labelCommits([{ sha: "abc", subject: "Release v0.3.12" }], releases);
    expect(out[0].subject).toMatch(/v0\.3\.12 —/);
  });

  it("normalizeGithubCommit prefers merge body line", () => {
    const c = normalizeGithubCommit({
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      commit: {
        message: "Merge pull request #60 from CryptoGnome/develop\n\nExit 0 on Railway redeploy SIGTERM",
        committer: { date: "2026-08-14T12:00:00Z" },
      },
    });
    expect(c.subject).toBe("Exit 0 on Railway redeploy SIGTERM");
  });
});
