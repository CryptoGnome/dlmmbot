/**
 * Isolate tests from the operator's live data/ tree (and any FARMER_* env the
 * farmer/dash PM2 processes export). Runs before each test file loads config.ts.
 */
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "farmer-vitest-"));
const tmpl = join(process.cwd(), "config.toml");
process.env.FARMER_CONFIG_PATH = join(dir, "config.toml");
process.env.FARMER_ENV_PATH = join(dir, ".env");
process.env.FARMER_DB_PATH = ":memory:";
delete process.env.FARMER_ROOT;

if (existsSync(tmpl)) copyFileSync(tmpl, process.env.FARMER_CONFIG_PATH);
else writeFileSync(process.env.FARMER_CONFIG_PATH, "");
