import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { C, SANS, sol, pct, tone, commas } from "../theme";
import { Stage, ShotStage, MascotStage, Kicker, Big, Sub, Rail, Card, TokenBadge, enter } from "../ui";
import type { Daily } from "../plan";

type P = { d: Daily; mascot?: { open: boolean; close: boolean } };

/** Count a number up from 0 — the one place a value animates rather than fades. */
function useCountUp(target: number, dur = 30, delay = 0) {
  const frame = useCurrentFrame();
  return interpolate(frame, [delay, delay + dur], [0, target], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

export const Title: React.FC<P> = ({ d, mascot }) => {
  const frame = useCurrentFrame();
  const t = enter(frame, 0, 22);
  const date = new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
  // With a mascot card the copy sits in the left third the image was
  // composed to leave empty; without one it's the plain title as before.
  const Frame = mascot?.open ? MascotStage : Stage;
  return (
    <Frame label="dlmmbot.com" file="mascot-open.png">
      <div style={{ opacity: t, translate: `0px ${(1 - t) * 30}px` }}>
        <div style={{ fontSize: 34, letterSpacing: 10, color: C.green, textTransform: "uppercase" }}>
          Daily update
        </div>
        <div
          style={{
            fontSize: mascot?.open ? 200 : 260, fontWeight: 600, lineHeight: 1, letterSpacing: -8, marginTop: 10,
            fontFamily: SANS, color: C.fg,
          }}
        >
          DAY {d.dayNumber}
        </div>
        <div style={{ fontSize: 38, color: C.dim, marginTop: 26 }}>
          {date} · autonomous Meteora DLMM bot · live on Solana
        </div>
      </div>
    </Frame>
  );
};

/** The dashboard itself, early — so the numbers that follow have a home. */
export const Dashboard: React.FC<P> = ({ d }) => (
  <ShotStage file="shots/overview.png" label="live dashboard" fit="cover">
    <Kicker>The bot runs in public</Kicker>
    <Sub delay={10} color={C.fg}>
      Every position, every exit rule, every bug — on one open dashboard.
    </Sub>
    <Sub delay={18} color={C.dim}>
      dlmmbot.com · running v{d.version ?? ""}
    </Sub>
  </ShotStage>
);

export const Headline: React.FC<P> = ({ d }) => {
  const v = useCountUp(d.today.pnl, 34, 8);
  const bal = useCountUp(d.balance.total, 34, 22);
  const up = d.today.pnl >= 0;
  return (
    <Stage
      label="today"
      rail={
        <Rail
          delay={30}
          rows={[
            { k: "Balance", v: `${bal.toFixed(2)} SOL` },
            { k: `All-time · ${d.allTime.closes} closes`, v: `${sol(d.allTime.pnl)} SOL`, c: tone(d.allTime.pnl) },
            { k: "In positions", v: `${d.balance.open.toFixed(2)} SOL` },
          ]}
        />
      }
    >
      <Kicker>Profit / loss today</Kicker>
      <Big color={tone(d.today.pnl)} size={230}>
        {sol(v)} <span style={{ fontSize: 100, color: C.dim }}>SOL</span>
      </Big>
      <Sub delay={26} color={tone(d.today.pnl)}>
        {pct(d.today.pct)} · {d.today.closes} trade{d.today.closes === 1 ? "" : "s"} closed
        {up ? " · green day" : " · red day"}
      </Sub>
      <Sub delay={34} color={C.dim}>
        ≈ ${commas(d.balance.usd)} at ${d.balance.solUsd}/SOL
      </Sub>
    </Stage>
  );
};

/**
 * The run so far: real equity chart, plus realized PnL over trailing windows.
 * A window the bot hasn't lived through yet is labelled with the history it
 * actually has — claiming a 90-day number on a 4-day book would be a lie.
 */
export const Trend: React.FC<P> = ({ d }) => {
  const frame = useCurrentFrame();
  const { historyDays, windows } = d.trend;
  // Only windows the bot has actually lived through. Early on, three identical
  // numbers reads as a broken chart rather than a short track record — so a
  // 4-day-old book shows one honest "since launch" card, and 7D/30D/90D appear
  // on their own as the history reaches them.
  const cards = [
    ...windows.filter((w) => w.full).map((w) => ({ k: `${w.days}D`, v: w.pnl })),
    { k: `Since launch · ${historyDays}d`, v: d.allTime.pnl },
  ];
  return (
    <ShotStage file="shots/equity.png" label="the run so far">
      <Kicker>Profit / loss over time</Kicker>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        {cards.map((c, i) => (
          <Card key={c.k} k={c.k} v={`${sol(c.v)} SOL`} c={tone(c.v)} delay={10 + i * 7} />
        ))}
      </div>
      <Sub delay={34} color={C.dim}>
        {d.allTime.closes} closes · win rate{" "}
        {d.allTime.winRate != null ? `${Math.round(d.allTime.winRate * 100)}%` : "—"} · all of it public.
      </Sub>
    </ShotStage>
  );
};

export const Funnel: React.FC<P> = ({ d }) => {
  const scanned = useCountUp(d.today.scanned, 40, 6);
  const frame = useCurrentFrame();
  const bar = enter(frame, 26, 26);
  // Taken as a share of scanned — visually ~0, which is the point.
  const takenPct = d.today.scanned > 0 ? (d.today.entries / d.today.scanned) * 100 : 0;
  return (
    <Stage
      label="the funnel"
      rail={
        <Rail
          delay={30}
          rows={[
            { k: "Taken", v: String(d.today.entries), c: C.green },
            { k: "Hit rate", v: `${takenPct.toFixed(3)}%` },
          ]}
        />
      }
    >
      <Kicker>Pools screened today</Kicker>
      <Big size={215}>{commas(scanned)}</Big>
      <div style={{ marginTop: 44, width: "100%", height: 14, backgroundColor: C.panel, border: `1px solid ${C.grid}`, overflow: "hidden" }}>
        <div style={{ width: `${bar * 100}%`, height: "100%", backgroundColor: C.grid }} />
      </div>
      <Sub delay={34}>
        <span style={{ color: C.green }}>{d.today.entries} taken</span>
        <span style={{ color: C.dim }}> — {takenPct.toFixed(3)}% of what it looked at.</span>
      </Sub>
      <Sub delay={42} color={C.dim}>Almost everything fails a gate. That is the job.</Sub>
    </Stage>
  );
};

export const Trade: React.FC<P> = ({ d }) => {
  const b = d.best!;
  const v = useCountUp(b.pnl, 30, 10);
  return (
    <Stage
      label="best trade"
      rail={
        d.worst && d.worst.pnl < 0 ? (
          <Rail
            delay={34}
            rows={[
              { k: "Worst close", v: d.worst.symbol },
              { k: d.worst.reason, v: sol(d.worst.pnl, 4), c: C.red },
            ]}
          />
        ) : undefined
      }
    >
      <Kicker>Standout close</Kicker>
      <TokenBadge symbol={b.symbol} icon={b.icon} size={150} />
      <Big size={190} color={tone(b.pnl)} delay={8}>{sol(v, 4)} <span style={{ fontSize: 80, color: C.dim }}>SOL</span></Big>
      <Sub delay={30}>
        Exit rule: <span style={{ color: C.accent }}>{b.reason}</span>
      </Sub>
    </Stage>
  );
};

export const Positions: React.FC<P> = ({ d }) => {
  const frame = useCurrentFrame();
  return (
    <ShotStage file="shots/positions.png" label="positions tab" fit="cover">
      <Kicker>Open right now</Kicker>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {d.open.slice(0, 4).map((p, i) => (
            <Card
              key={`${p.symbol}-${i}`}
              k={`${p.symbol} · ${p.status} range`}
              icon={p.icon}
              v={`${sol(p.pnl, 4)} SOL`}
              c={tone(p.pnl)}
              delay={10 + i * 6}
              minWidth={340}
            />
          ))}
        </div>
    </ShotStage>
  );
};

export const Analytics: React.FC<P> = ({ d }) => {
  const frame = useCurrentFrame();
  const top = d.reasons.slice(0, 4);
  // reasons.png, not equity.png — Trend already shows the equity chart, and two
  // beats on the same screenshot reads as a stuck video.
  return (
    <ShotStage file="shots/reasons.png" label="analytics tab">
      <Kicker>How it exited</Kicker>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {top.map((r, i) => (
            <Card
              key={r.reason}
              k={`${r.reason} ×${r.n}`}
              v={`${sol(r.pnl)} SOL`}
              c={tone(r.pnl)}
              delay={10 + i * 6}
              minWidth={280}
            />
          ))}
        </div>
        <Sub delay={34} color={C.dim}>
          {d.allTime.closes} closes all-time · win rate {d.allTime.winRate != null ? `${Math.round(d.allTime.winRate * 100)}%` : "—"}
        </Sub>
    </ShotStage>
  );
};

export const Shipped: React.FC<P> = ({ d }) => {
  const frame = useCurrentFrame();
  const top = d.releases.slice(0, 3);
  return (
    <Stage label="shipped today">
      <Kicker>Fixes shipped</Kicker>
      <Big size={200} color={C.accent}>{d.releases.length}</Big>
      <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 16 }}>
        {top.map((r, i) => {
          const t = enter(frame, 20 + i * 8, 16);
          return (
            <div
              key={r.tag}
              style={{ opacity: t, translate: `0px ${(1 - t) * 14}px`, display: "flex", gap: 20, alignItems: "baseline" }}
            >
              <span style={{ fontSize: 30, color: C.green, minWidth: 140 }}>{r.tag}</span>
              <span style={{ fontSize: 32, color: C.muted, maxWidth: 1400 }}>{r.title}</span>
            </div>
          );
        })}
      </div>
      <Sub delay={48} color={C.dim}>
        {d.errors24h === 0 ? "Zero unresolved errors in 24h." : `${d.errors24h} error(s) open.`}
      </Sub>
    </Stage>
  );
};

export const Outro: React.FC<P> = ({ d, mascot }) => {
  const frame = useCurrentFrame();
  const t = enter(frame, 0, 20);
  const Frame = mascot?.close ? MascotStage : Stage;
  return (
    <Frame label={`v${d.version ?? ""}`} file="mascot-close.png">
      <div style={{ opacity: t, translate: `0px ${(1 - t) * 20}px` }}>
        <div style={{ fontSize: 40, color: C.dim, letterSpacing: 6, textTransform: "uppercase" }}>
          Follow the run
        </div>
        <div style={{ fontSize: mascot?.close ? 118 : 170, fontWeight: 700, color: C.green, marginTop: 14, letterSpacing: -5 }}>
          dlmmbot.com
        </div>
        <div style={{ fontSize: 36, color: C.muted, marginTop: 26 }}>
          Open dashboard · every trade, every rule, every bug — in public.
        </div>
      </div>
    </Frame>
  );
};

export const SCENES = { title: Title, dashboard: Dashboard, headline: Headline, trend: Trend, funnel: Funnel, trade: Trade, positions: Positions, analytics: Analytics, shipped: Shipped, outro: Outro } as const;
