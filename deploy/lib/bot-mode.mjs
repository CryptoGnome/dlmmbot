/**
 * Dashboard book mode — same double gate as the farmer (`isLive` / `currentMode`).
 * Volume `.env` FARMER_MODE overrides boot env; [exec].mode must also be live.
 */
import { readFileSync } from "node:fs";
import { runtimePaths } from "./runtime-paths.mjs";

function readFarmerMode(envPath) {
  let farmerMode = (process.env.FARMER_MODE || "paper").toLowerCase();
  try {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = /^\s*FARMER_MODE\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = (m[1] ?? "").trim();
      if (
        (v.startsWith('"') && v.endsWith('"'))
        || (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      v = v.trim().toLowerCase();
      if (v === "live" || v === "paper") farmerMode = v;
      break;
    }
  } catch { /* missing .env is fine */ }
  return farmerMode === "live" ? "live" : "paper";
}

/** Parse only [exec].mode — sizing also has a `mode` key. */
function readExecMode(configPath) {
  try {
    const toml = readFileSync(configPath, "utf8");
    const section = /\[exec\]([\s\S]*?)(?=\n\[|$)/.exec(toml);
    const chunk = section ? section[1] : "";
    const m = /^\s*mode\s*=\s*"?(paper|live)"?/m.exec(chunk);
    if (m) return m[1];
  } catch { /* */ }
  return "paper";
}

/** @returns {"paper"|"live"} */
export function resolveBotMode(root = process.cwd()) {
  const { envPath, configPath } = runtimePaths(root);
  const farmerMode = readFarmerMode(envPath);
  const execMode = readExecMode(configPath);
  return execMode === "live" && farmerMode === "live" ? "live" : "paper";
}
