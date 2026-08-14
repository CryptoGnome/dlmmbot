<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

const publicPem = ref("");
const copied = ref(false);
const gmgnLink = computed(() =>
  publicPem.value
    ? `https://gmgn.ai/ai/generateapi?pbk=${encodeURIComponent(publicPem.value)}`
    : "https://gmgn.ai/ai",
);

function toPem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function generate() {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  publicPem.value = toPem("PUBLIC KEY", spki);
  copied.value = false;
}

async function copy() {
  if (!publicPem.value) await generate();
  try {
    await navigator.clipboard.writeText(publicPem.value);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    /* manual copy */
  }
}

onMounted(() => { void generate(); });
</script>

<template>
  <div class="dash-token-gen" role="group" aria-label="GMGN Ed25519 public key generator">
    <p class="dash-token-gen__hint">
      GMGN needs an <strong>Ed25519 public key</strong> before it issues a query API key.
      Click <strong>Generate</strong>, copy the block below (including <code>BEGIN</code> / <code>END</code> lines),
      paste into <a href="https://gmgn.ai/ai" target="_blank" rel="noreferrer">gmgn.ai/ai</a>
      → <strong>Upload Public Key</strong>, then paste the API key GMGN returns as
      <code>GMGN_API_KEY</code>. Generated in your browser — nothing is sent to our servers.
      <strong>One key per running bot</strong> (staging + production need separate keys).
    </p>
    <pre class="dash-token-gen__value dash-token-gen__pem" aria-live="polite">{{ publicPem || "…" }}</pre>
    <div class="dash-token-gen__row">
      <button type="button" class="dash-token-gen__btn" @click="generate">Generate</button>
      <button type="button" class="dash-token-gen__btn primary" @click="copy">
        {{ copied ? "Copied" : "Copy public key" }}
      </button>
      <a
        class="dash-token-gen__btn dash-token-gen__link"
        :href="gmgnLink"
        target="_blank"
        rel="noreferrer"
      >Open GMGN (pre-filled)</a>
    </div>
  </div>
</template>
