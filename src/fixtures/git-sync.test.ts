// @ts-nocheck — imports deploy/*.mjs (no TS declarations)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectDeployContext,
  envCommitSha,
  headSourceLabel,
  resolveDeployBranch,
  resolveHeadSha,
  shortSha,
  shasMatch,
  syncFromShas,
  usesPlatformHead,
} from "../../deploy/lib/git-source.mjs";

const ENV_KEYS = [
  "RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_GIT_BRANCH", "VERCEL_GIT_COMMIT_SHA", "DEPLOY_BRANCH", "COMMIT_SHA",
] as const;

describe("git-source (build pill)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("detects Railway vs local", () => {
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_PROJECT_ID;
    expect(detectDeployContext()).toBe("local");
    process.env.RAILWAY_ENVIRONMENT = "production";
    expect(detectDeployContext()).toBe("railway");
    expect(usesPlatformHead()).toBe(true);
  });

  it("reads platform commit env vars", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abcdef0123456789";
    expect(envCommitSha()).toBe("abcdef0123456789");
    expect(shortSha(envCommitSha()!)).toBe("abcdef0");
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = "deadbeef12345678";
    expect(envCommitSha()).toBe("deadbeef12345678");
  });

  it("resolves deploy branch from env chain", () => {
    process.env.DEPLOY_BRANCH = "develop";
    expect(resolveDeployBranch()).toBe("develop");
    delete process.env.DEPLOY_BRANCH;
    process.env.RAILWAY_GIT_BRANCH = "main";
    expect(resolveDeployBranch()).toBe("main");
  });

  it("prefers platform SHA over local git on Railway", () => {
    process.env.RAILWAY_ENVIRONMENT = "production";
    process.env.RAILWAY_GIT_COMMIT_SHA = "aaaabbbbccccdddd";
    const git = () => "1111111111111111";
    const res = resolveHeadSha("/repo", git);
    expect(res.source).toBe("railway");
    expect(res.sha).toBe("aaaabbbbccccdddd");
  });

  it("prefers local git on PM2 VPS", () => {
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    const git = (_r: string, args: string[]) => (
      args[0] === "rev-parse" && args[1] === "HEAD" ? "2222222222222222" : null
    );
    const res = resolveHeadSha("/repo", git);
    expect(res.source).toBe("git");
    expect(res.sha).toBe("2222222222222222");
  });

  it("falls back to env SHA when git missing", () => {
    delete process.env.RAILWAY_ENVIRONMENT;
    process.env.COMMIT_SHA = "3333333333333333";
    const git = () => null;
    const res = resolveHeadSha("/repo", git);
    expect(res.source).toBe("env");
    expect(res.sha).toBe("3333333333333333");
  });

  it("matches abbreviated vs full SHAs and syncs without git", () => {
    expect(shasMatch("deadbeef", "deadbeefcafebabe")).toBe(true);
    expect(shasMatch("deadbeefcafebabe", "deadbeef")).toBe(true);
    expect(shasMatch("aaaaaaaa", "bbbbbbbb")).toBe(false);
    expect(syncFromShas("abc1234", "abc1234ffff")).toBe("current");
    expect(syncFromShas("abc1234", "def5678")).toBe("behind");
    expect(syncFromShas(null, "abc")).toBe("unknown");
  });

  it("labels head sources for tooltips", () => {
    expect(headSourceLabel("railway")).toContain("Railway");
    expect(headSourceLabel("git")).toContain("git");
  });
});
