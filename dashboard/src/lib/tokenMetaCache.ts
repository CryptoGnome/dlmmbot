/** Client-side mint → {symbol,name,icon} cache so logos stay fast across tabs/reloads. */

export type CachedTokenMeta = {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  icon_url?: string | null;
};

const KEY = "dlmm_token_meta_v1";
const LEGACY_KEY = "meteora_token_meta_v1";
const MAX = 400;

type Store = Record<string, CachedTokenMeta>;

let mem: Store | null = null;

function readStore(): Store {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) {
      mem = {};
      return mem;
    }
    const parsed = JSON.parse(raw) as Store;
    mem = parsed && typeof parsed === "object" ? parsed : {};
    return mem;
  } catch {
    mem = {};
    return mem;
  }
}

function writeStore(store: Store): void {
  mem = store;
  try {
    const keys = Object.keys(store);
    if (keys.length > MAX) {
      for (const k of keys.slice(0, keys.length - MAX)) delete store[k];
    }
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch { /* quota */ }
}

export function lookupTokenMeta(mint: string | null | undefined): CachedTokenMeta | null {
  if (!mint) return null;
  return readStore()[mint] ?? null;
}

export function rememberTokenMeta(meta: CachedTokenMeta): void {
  if (!meta?.mint) return;
  const store = readStore();
  const prev = store[meta.mint] ?? { mint: meta.mint };
  store[meta.mint] = {
    mint: meta.mint,
    symbol: meta.symbol ?? prev.symbol ?? null,
    name: meta.name ?? prev.name ?? null,
    icon_url: meta.icon_url ?? prev.icon_url ?? null,
  };
  writeStore(store);
}

/** Merge a watch.token_meta map into localStorage. */
export function mergeTokenMetaMap(
  map: Record<string, CachedTokenMeta> | null | undefined,
): void {
  if (!map) return;
  const store = readStore();
  let changed = false;
  for (const [mint, meta] of Object.entries(map)) {
    if (!mint || !meta) continue;
    const prev = store[mint];
    const next = {
      mint,
      symbol: meta.symbol ?? prev?.symbol ?? null,
      name: meta.name ?? prev?.name ?? null,
      icon_url: meta.icon_url ?? prev?.icon_url ?? null,
    };
    if (
      !prev
      || prev.symbol !== next.symbol
      || prev.name !== next.name
      || prev.icon_url !== next.icon_url
    ) {
      store[mint] = next;
      changed = true;
    }
  }
  if (changed) writeStore(store);
}
