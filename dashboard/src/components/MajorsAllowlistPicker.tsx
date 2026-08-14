import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { searchMajorsSymbols, type MajorsSearchHit } from "@/lib/api";
import { Badge, Spinner } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { Plus, Search, X } from "lucide-react";

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function parseAllowlist(raw: string): string[] {
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function toneClass(tone: MajorsSearchHit["best"]["statusTone"]): string {
  if (tone === "ok") return "text-ok";
  if (tone === "warn") return "text-warn";
  return "text-dim";
}

export function MajorsAllowlistPicker({
  value,
  saved,
  changed,
  onChange,
}: {
  value: string;
  saved: string;
  changed: boolean;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MajorsSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const symbols = useMemo(() => parseAllowlist(value), [value]);
  const savedSymbols = useMemo(() => new Set(parseAllowlist(saved)), [saved]);

  const setSymbols = useCallback((next: string[]) => {
    onChange(next.join(", "));
  }, [onChange]);

  const addSymbol = useCallback((sym: string) => {
    const up = sym.toUpperCase();
    if (symbols.includes(up)) return;
    setSymbols([...symbols, up]);
    setQuery("");
    setHits([]);
    setOpen(false);
  }, [symbols, setSymbols]);

  const removeSymbol = useCallback((sym: string) => {
    setSymbols(symbols.filter((s) => s !== sym));
  }, [symbols, setSymbols]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setHits([]);
      setSearchErr(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchErr(null);
    const t = setTimeout(() => {
      searchMajorsSymbols(q, 10)
        .then((r) => { setHits(r.hits); setOpen(true); })
        .catch((e) => setSearchErr((e as Error).message ?? String(e)))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={boxRef} className="col-span-full flex min-w-0 flex-col gap-2 border border-grid px-2.5 py-2">
      <div>
        <div className={`text-[11px] leading-snug ${changed ? "text-hover" : "text-muted"}`}>
          Allowlist{changed ? " *" : ""}
        </div>
        <p className="mt-1 text-[10px] leading-snug text-dim">
          Search Meteora SOL pools by ticker — no contract address needed. Discovery matches the pool name prefix (e.g. PUMP-SOL → PUMP).
        </p>
      </div>

      <div className="flex min-h-[1.75rem] flex-wrap gap-1.5">
        {symbols.length === 0 && (
          <span className="text-[10px] text-dim">No symbols yet — search below to add.</span>
        )}
        {symbols.map((sym) => {
          const isNew = !savedSymbols.has(sym);
          return (
            <button
              key={sym}
              type="button"
              className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] tracking-wide uppercase ${
                isNew ? "border-hover/60 text-hover" : "border-grid text-muted"
              }`}
              onClick={() => removeSymbol(sym)}
              title="Remove from allowlist"
            >
              {sym}
              <Icon icon={X} size={10} />
            </button>
          );
        })}
      </div>

      <div className="relative">
        <div className="flex items-center gap-2 border border-grid bg-panel/30 px-2 py-1.5">
          <Icon icon={Search} size={12} className="shrink-0 text-dim" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-dim"
            placeholder="Type ticker — PUMP, ANSEM, JUP…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (hits.length) setOpen(true); }}
          />
          {searching && <Spinner className="h-3 w-3 shrink-0" />}
        </div>

        {searchErr && (
          <p className="mt-1 text-[10px] text-warn">{searchErr}</p>
        )}

        {open && query.trim() && !searchErr && (
          <div className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto border border-grid bg-panel shadow-lg">
            {hits.length === 0 && !searching && (
              <p className="px-2.5 py-2 text-[10px] text-dim">
                No SOL-quoted DLMM pool found in the Meteora sweep for “{query.trim().toUpperCase()}”.
              </p>
            )}
            {hits.map((hit) => {
              const added = symbols.includes(hit.symbol);
              return (
                <div
                  key={hit.symbol}
                  className="flex items-start gap-2 border-b border-grid/60 px-2.5 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-display text-[12px] font-semibold text-fg">{hit.symbol}</span>
                      {hit.onAllowlist && <Badge tone="accent">saved</Badge>}
                      {hit.best.ready && <Badge tone="ok">ready</Badge>}
                      {hit.poolCount > 1 && (
                        <span className="text-[9px] text-dim">{hit.poolCount} pools</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted">
                      {hit.best.name} · TVL {fmtUsd(hit.best.tvlUsd)} · fee/TVL {hit.best.feeTvl24hPct.toFixed(2)}%/d
                    </div>
                    <div className={`mt-0.5 text-[9px] ${toneClass(hit.best.statusTone)}`}>
                      {hit.best.statusText}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={added}
                    className="inline-flex shrink-0 items-center gap-1 border border-ok/50 px-2 py-1 text-[9px] tracking-wider text-ok uppercase hover:border-hover disabled:opacity-40"
                    onClick={() => addSymbol(hit.symbol)}
                  >
                    <Icon icon={Plus} size={10} />
                    {added ? "Added" : "Add"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
