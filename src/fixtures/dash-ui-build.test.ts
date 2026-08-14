// @ts-nocheck
import { describe, expect, it } from "vitest";
import { fingerprintDashHtml } from "../../deploy/lib/dash-ui-build.mjs";

describe("dash-ui-build", () => {
  it("fingerprints hashed asset refs", () => {
    const a = fingerprintDashHtml(
      `<script type="module" src="/assets/index-abc123.js"></script><link href="/assets/index-def456.css">`,
    );
    const b = fingerprintDashHtml(
      `<script type="module" src="/assets/index-abc123.js"></script><link href="/assets/index-ZZZZZZ.css">`,
    );
    expect(a).toMatch(/^[a-f0-9]{12}$/);
    expect(a).not.toBe(b);
  });

  it("returns null for empty html", () => {
    expect(fingerprintDashHtml("")).toBeNull();
  });
});
