#!/usr/bin/env node
/**
 * Validate the official settings profiles against the live machinery, so a
 * profile can never silently rot:
 *   1. every update key is in PROFILE_ALLOWLIST (else apply drops it silently),
 *   2. every key exists in the template config.toml with a matching value type
 *      (else the Settings writer rejects it as unknown),
 *   3. "balanced" exactly equals the template for every key it pins — its
 *      description promises "the shipped defaults", so drift there is a lie,
 *   4. conservative <= balanced <= aggressive on the risk-ordered numeric
 *      levers, so a tier can't quietly invert its own meaning again (the
 *      original descriptions shipped with stop-loss semantics backwards).
 * Run in CI and before editing profiles. Exit 1 on any violation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { PROFILE_ALLOWLIST } from "../deploy/lib/profiles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = parse(readFileSync(join(root, "config.toml"), "utf8"));
const dir = join(root, "profiles", "official");

const errors = [];
const profiles = new Map();

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  let p;
  try {
    p = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch (e) {
    errors.push(`${file}: invalid JSON — ${e.message}`);
    continue;
  }
  for (const field of ["schema", "id", "name", "description", "updates"]) {
    if (p[field] === undefined) errors.push(`${file}: missing "${field}"`);
  }
  if (p.updates) profiles.set(p.id, p);

  for (const [key, val] of Object.entries(p.updates ?? {})) {
    if (!PROFILE_ALLOWLIST.has(key)) {
      errors.push(`${file}: "${key}" is not in PROFILE_ALLOWLIST — apply would silently drop it`);
      continue;
    }
    const [section, name] = key.split(".");
    const tmplVal = template?.[section]?.[name];
    if (tmplVal === undefined) {
      errors.push(`${file}: "${key}" does not exist in config.toml — Settings would reject it`);
      continue;
    }
    const tType = Array.isArray(tmplVal) ? "array" : typeof tmplVal;
    const vType = Array.isArray(val) ? "array" : typeof val;
    if (tType !== vType) {
      errors.push(`${file}: "${key}" is ${vType} but the template's is ${tType}`);
    }
  }
}

// 3. Balanced must equal the template on every key it pins.
const balanced = profiles.get("balanced");
if (balanced) {
  for (const [key, val] of Object.entries(balanced.updates)) {
    const [section, name] = key.split(".");
    const tmplVal = template?.[section]?.[name];
    if (tmplVal === undefined) continue; // already reported above
    if (JSON.stringify(val) !== JSON.stringify(tmplVal)) {
      errors.push(
        `balanced.json: "${key}" = ${JSON.stringify(val)} but the template ships ${JSON.stringify(tmplVal)} — ` +
        `balanced promises the shipped defaults`,
      );
    }
  }
}

// 4. Risk ordering on the levers whose direction is unambiguous.
//    dir +1: conservative <= balanced <= aggressive (more = riskier)
//    dir -1: conservative >= balanced >= aggressive (more = safer)
const ORDERED = [
  ["sizing.max_positions", +1],
  ["sizing.kelly_fraction", +1],
  ["sizing.kelly_max_position_frac", +1],
  ["sizing.reserve_sol", -1],
  ["sizing.per_token_max_pct", +1],
  ["sizing.circuit_daily_loss_pct", +1],   // higher tolerance = riskier
  ["sizing.cluster_brake_exits", +1],      // more losses before pausing = riskier
  ["manage.stop_loss_frac", -1],           // higher frac = cuts EARLIER = safer
  ["manage.max_age_h", +1],
  ["manage.reentry_max_per_24h", +1],
  ["manage.loss_reentry_cooldown_h", -1],
  ["gates.mcap_min_usd", -1],
  ["gates.tvl_min_usd", -1],
  ["gates.vol_30m_min_usd", -1],
  ["gates.max_pool_share_pct", +1],
  ["vetting.age_min_minutes", -1],
  ["vetting.insider_cluster_max_pct", +1],
  ["vetting.single_holder_max_pct", +1],
  ["vetting.top10_max_pct", +1],
  ["vetting.rugcheck_veto_normalised", +1],
  ["majors.size_sol", +1],
  ["majors.max_slots", +1],
];
const tiers = ["conservative", "balanced", "aggressive"];
if (tiers.every((t) => profiles.has(t))) {
  for (const [key, sign] of ORDERED) {
    const vals = tiers.map((t) => profiles.get(t).updates[key]);
    if (vals.some((v) => typeof v !== "number")) continue; // not pinned by every tier
    for (let i = 0; i < 2; i++) {
      if ((vals[i + 1] - vals[i]) * sign < 0) {
        errors.push(
          `risk ordering violated for "${key}": ${tiers[i]}=${vals[i]} vs ${tiers[i + 1]}=${vals[i + 1]} ` +
          `(expected ${sign > 0 ? "non-decreasing" : "non-increasing"} toward aggressive)`,
        );
      }
    }
  }
}

if (errors.length) {
  console.error(`profile validation FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`profiles OK: ${profiles.size} official profile(s) validated against allowlist, template, and risk ordering`);
