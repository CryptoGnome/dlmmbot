import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBotMode } from "../../deploy/lib/bot-mode.mjs";

describe("resolveBotMode", () => {
  let root: string;
  let prevFarmer: string | undefined;
  let prevEnvPath: string | undefined;
  let prevConfigPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bot-mode-"));
    mkdirSync(join(root, "data"));
    prevFarmer = process.env.FARMER_MODE;
    prevEnvPath = process.env.FARMER_ENV_PATH;
    prevConfigPath = process.env.FARMER_CONFIG_PATH;
    delete process.env.FARMER_ENV_PATH;
    delete process.env.FARMER_CONFIG_PATH;
    delete process.env.FARMER_MODE;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevFarmer === undefined) delete process.env.FARMER_MODE;
    else process.env.FARMER_MODE = prevFarmer;
    if (prevEnvPath === undefined) delete process.env.FARMER_ENV_PATH;
    else process.env.FARMER_ENV_PATH = prevEnvPath;
    if (prevConfigPath === undefined) delete process.env.FARMER_CONFIG_PATH;
    else process.env.FARMER_CONFIG_PATH = prevConfigPath;
  });

  function write(execMode: string, farmerMode: string) {
    const configPath = join(root, "data", "config.toml");
    const envPath = join(root, "data", ".env");
    writeFileSync(
      configPath,
      `[sizing]\nmode = "kelly"\n\n[exec]\nmode = "${execMode}"\n`,
    );
    writeFileSync(envPath, `FARMER_MODE=${farmerMode}\n`);
    process.env.FARMER_CONFIG_PATH = configPath;
    process.env.FARMER_ENV_PATH = envPath;
    process.env.FARMER_MODE = farmerMode;
  }

  it("stays paper unless both gates are live", () => {
    write("live", "paper");
    expect(resolveBotMode(root)).toBe("paper");
    write("paper", "live");
    expect(resolveBotMode(root)).toBe("paper");
  });

  it("is live only when exec + FARMER_MODE are live", () => {
    write("live", "live");
    expect(resolveBotMode(root)).toBe("live");
  });

  it("ignores sizing mode=kelly when reading exec", () => {
    const configPath = join(root, "data", "config.toml");
    const envPath = join(root, "data", ".env");
    writeFileSync(
      configPath,
      `mode = "kelly"\n\n[exec]\nmode = "live"\n`,
    );
    writeFileSync(envPath, "FARMER_MODE=live\n");
    process.env.FARMER_CONFIG_PATH = configPath;
    process.env.FARMER_ENV_PATH = envPath;
    process.env.FARMER_MODE = "live";
    expect(resolveBotMode(root)).toBe("live");
  });
});
