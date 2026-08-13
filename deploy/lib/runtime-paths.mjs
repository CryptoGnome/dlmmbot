/**
 * Runtime data dir — config/env/db live outside the tracked tree (gitignored data/).
 * Repo config.toml / .env are templates; Settings writes never dirty the checkout.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function dataDir(root = process.cwd()) {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  }
  if (process.env.FARMER_DB_PATH) {
    return dirname(resolve(process.env.FARMER_DB_PATH));
  }
  return resolve(root, "data");
}

export function runtimePaths(root = process.cwd()) {
  const dir = dataDir(root);
  return {
    dataDir: dir,
    configPath: process.env.FARMER_CONFIG_PATH
      ? resolve(process.env.FARMER_CONFIG_PATH)
      : join(dir, "config.toml"),
    envPath: process.env.FARMER_ENV_PATH
      ? resolve(process.env.FARMER_ENV_PATH)
      : join(dir, ".env"),
    dbPath: process.env.FARMER_DB_PATH
      ? resolve(process.env.FARMER_DB_PATH)
      : join(dir, "farmer.db"),
  };
}

/** Seed data/config.toml (and optionally data/.env) from repo templates if missing. */
export function ensureRuntimeData(root = process.cwd()) {
  const { dataDir: dir, configPath, envPath } = runtimePaths(root);
  mkdirSync(dir, { recursive: true });

  const templateConfig = resolve(root, "config.toml");
  if (!existsSync(configPath) && existsSync(templateConfig)) {
    copyFileSync(templateConfig, configPath);
    console.log(`[runtime] seeded ${configPath}`);
  }

  const templateEnv = resolve(root, ".env");
  if (!existsSync(envPath) && existsSync(templateEnv)) {
    copyFileSync(templateEnv, envPath);
    console.log(`[runtime] seeded ${envPath}`);
  }

  return runtimePaths(root);
}

/** Apply default FARMER_* env pointing at the data dir (does not override existing). */
export function applyRuntimeEnv(root = process.cwd()) {
  const paths = ensureRuntimeData(root);
  if (!process.env.FARMER_CONFIG_PATH) process.env.FARMER_CONFIG_PATH = paths.configPath;
  if (!process.env.FARMER_ENV_PATH) process.env.FARMER_ENV_PATH = paths.envPath;
  if (!process.env.FARMER_DB_PATH) process.env.FARMER_DB_PATH = paths.dbPath;
  if (!process.env.FARMER_ROOT) process.env.FARMER_ROOT = resolve(root);
  return paths;
}
