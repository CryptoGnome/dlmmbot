#!/usr/bin/env node
/**
 * Read-only live-book watch — gates / Kelly / mark-gap integrity.
 * Run on gn0meserver: node deploy/watch-live-book.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveBookSnapshot } from "./lib/live-book-snapshot.mjs";

const root = resolve(
  process.env.FARMER_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

console.log(JSON.stringify(buildLiveBookSnapshot(root), null, 2));
