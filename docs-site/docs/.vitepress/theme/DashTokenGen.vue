<script setup lang="ts">
import { onMounted, ref } from "vue";

const token = ref("");
const copied = ref(false);

function generate() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  token.value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  copied.value = false;
}

async function copy() {
  if (!token.value) generate();
  try {
    await navigator.clipboard.writeText(token.value);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    /* select fallback — user can copy manually */
  }
}

onMounted(generate);
</script>

<template>
  <div class="dash-token-gen" role="group" aria-label="Dash token generator">
    <p class="dash-token-gen__hint">
      Click <strong>Generate</strong>, then <strong>Copy</strong>. Paste into Railway → Variables as
      <code>DASH_TOKEN</code>. Made in your browser — nothing is sent to our servers.
    </p>
    <div class="dash-token-gen__row">
      <code class="dash-token-gen__value" aria-live="polite">{{ token || "…" }}</code>
      <button type="button" class="dash-token-gen__btn" @click="generate">Generate</button>
      <button type="button" class="dash-token-gen__btn primary" @click="copy">
        {{ copied ? "Copied" : "Copy" }}
      </button>
    </div>
  </div>
</template>
