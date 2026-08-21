import { Connection, type ConnectionConfig } from "@solana/web3.js";
import { env } from "./config.js";

/**
 * Per-attempt RPC timeout. A node that accepts the TCP connection and never
 * answers otherwise wedges the manager tick indefinitely — the one failure
 * shape the watchdog cannot help with, because the loop never gets to run it.
 */
const RPC_TIMEOUT_MS = 20_000;

/** Primary-side failures worth a second shot at the backup node. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A Connection that actually honours RPC_URL_FALLBACK.
 *
 * The setting has been offered in the dashboard as "used if the primary RPC
 * fails" since it was added, but nothing read `env().rpcUrlFallback` — every
 * call site built its own `new Connection(env().rpcUrl)`, so a primary outage
 * took the bot down with a backup node configured and idle. That includes the
 * live boot path, where the failure mode is the bot refusing to start while
 * positions sit on chain.
 *
 * Failover is per-request, not per-process: each request tries the primary,
 * and on a connect-level throw or a retryable status tries the fallback once.
 * There is no stickiness — a primary that recovers is used again immediately,
 * and a fallback that is only needed for one request costs one extra call.
 *
 * Re-sending a transaction to a second node is safe: Solana dedupes by
 * signature, so the worst case is the same signed transaction reaching the
 * cluster twice, which is what any rebroadcast does anyway.
 */
export function makeConnection(config: ConnectionConfig = { commitment: "confirmed" }): Connection {
  const { rpcUrl, rpcUrlFallback } = env();
  return new Connection(rpcUrl, {
    ...config,
    fetch: async (input, init) => {
      // A fresh signal per attempt: reusing the caller's would hand the
      // fallback an already-aborted signal after a primary timeout, so the
      // retry would fail instantly and the failover would be decorative.
      const send = (url: Parameters<typeof fetch>[0]) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!rpcUrlFallback) return send(input);
      try {
        const res = await send(input);
        if (!RETRYABLE_STATUS.has(res.status)) return res;
        void res.body?.cancel().catch(() => {});  // don't hold the socket open on a body we discard
      } catch (e) {
        // Only a connect/timeout failure reaches here; a bad request would
        // have come back as a response. Fall through to the backup node, but
        // keep the original error if that one is down too — it names the
        // endpoint the operator actually configured as primary.
        return send(rpcUrlFallback).catch(() => { throw e; });
      }
      return send(rpcUrlFallback);
    },
  });
}
