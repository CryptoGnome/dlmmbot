/**
 * Terms of Service & Risk Waiver — version gate for setup.
 * Full text lives in repo-root TERMS.md (served by the dashboard API).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const TERMS_VERSION = "1";

export function loadTermsMarkdown(root) {
  const path = resolve(root, "TERMS.md");
  if (!existsSync(path)) {
    return `# Terms unavailable\n\nTERMS.md missing on this host. See https://github.com/CryptoGnome/dlmmbot/blob/main/TERMS.md\n`;
  }
  return readFileSync(path, "utf8");
}

export function termsAccepted(setup) {
  return setup?.termsVersion === TERMS_VERSION;
}
