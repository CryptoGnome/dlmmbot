import { config, _setConfigForTests, type Config } from "../config.js";

/** Deep-clone live config, apply patch, install for the duration of a test file. */
export function installConfig(patch?: (c: Config) => void): Config {
  const c = structuredClone(config()) as Config;
  patch?.(c);
  _setConfigForTests(c);
  return c;
}

export function restoreConfig(): void {
  _setConfigForTests(null);
}
