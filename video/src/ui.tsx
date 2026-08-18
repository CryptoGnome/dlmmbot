import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, MONO, SANS, PANEL_RADIUS } from "./theme";

/** Frames→progress with a clamped ease-out. The one curve the whole video uses for enters. */
export function enter(frame: number, delay: number, dur: number): number {
  return interpolate(frame, [delay, delay + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

/**
 * Scene chrome: background, hairline grid, corner label, and an optional right
 * rail. 16:9 leaves a lot of frame to the right of a left-aligned number, so a
 * scene that has secondary facts puts them there rather than letting the eye
 * fall off the edge.
 */
export function Stage({
  label, children, rail,
}: { label: string; children: React.ReactNode; rail?: React.ReactNode; file?: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  // Every scene fades its last 8 frames so cuts never hard-flash.
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, color: C.fg, fontFamily: MONO, opacity: out }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`,
          backgroundSize: "120px 120px",
          opacity: 0.55,
        }}
      />
      <AbsoluteFill
        style={{
          padding: 96, display: "flex", flexDirection: "row",
          alignItems: "center", justifyContent: "space-between", gap: 70,
        }}
      >
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>{children}</div>
        {rail ? <div style={{ flex: "0 0 520px" }}>{rail}</div> : null}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute", left: 96, bottom: 52, display: "flex", gap: 14, alignItems: "center",
          fontSize: 24, letterSpacing: 5, color: C.dim, textTransform: "uppercase",
        }}
      >
        <span style={{ width: 11, height: 11, backgroundColor: C.green, borderRadius: 2 }} />
        {label}
      </div>
    </AbsoluteFill>
  );
}

/** Right-rail stat row. Label above, value below, hairline between rows. */
export function Rail({ rows, delay = 0 }: { rows: Array<{ k: string; v: string; c?: string }>; delay?: number }) {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {rows.map((r, i) => {
        const t = enter(frame, delay + i * 6, 16);
        return (
          <div
            key={r.k}
            style={{
              opacity: t, translate: `0px ${(1 - t) * 12}px`,
              borderTop: `1px solid ${C.grid}`, paddingTop: 18,
            }}
          >
            <div style={{ fontSize: 24, letterSpacing: 4, color: C.dim, textTransform: "uppercase" }}>{r.k}</div>
            <div style={{ fontSize: 54, color: r.c ?? C.fg, marginTop: 8 }}>{r.v}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Kicker({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const frame = useCurrentFrame();
  const t = enter(frame, delay, 14);
  return (
    <div
      style={{
        fontSize: 30, letterSpacing: 7, color: C.dim, textTransform: "uppercase",
        opacity: t, translate: `0px ${(1 - t) * 14}px`, marginBottom: 22,
      }}
    >
      {children}
    </div>
  );
}

export function Big({
  children, color = C.fg, size = 190, delay = 0,
}: { children: React.ReactNode; color?: string; size?: number; delay?: number }) {
  const frame = useCurrentFrame();
  const t = enter(frame, delay, 20);
  return (
    <div
      style={{
        fontSize: size, lineHeight: 1, fontWeight: 600, color, letterSpacing: -3, fontFamily: SANS,
        opacity: t, translate: `0px ${(1 - t) * 26}px`,
      }}
    >
      {children}
    </div>
  );
}

export function Sub({ children, delay = 0, color = C.muted }: { children: React.ReactNode; delay?: number; color?: string }) {
  const frame = useCurrentFrame();
  const t = enter(frame, delay, 16);
  return (
    <div style={{ fontSize: 36, color, marginTop: 26, opacity: t, translate: `0px ${(1 - t) * 12}px` }}>
      {children}
    </div>
  );
}

/**
 * A stat card, styled exactly like the dashboard's `.panel`: panel fill, 1px
 * grid border, and square corners. Rounded cards were one of the tells that
 * the video wasn't quite the same product as the site.
 */
export function Card({
  k, v, c, delay = 0, minWidth = 300, icon,
}: { k: string; v: string; c?: string; delay?: number; minWidth?: number; icon?: string | null }) {
  const frame = useCurrentFrame();
  const t = enter(frame, delay, 16);
  return (
    <div
      style={{
        opacity: t, translate: `0px ${(1 - t) * 16}px`,
        backgroundColor: C.panel, border: `1px solid ${C.grid}`, borderRadius: PANEL_RADIUS,
        padding: "18px 30px", minWidth,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 26, color: C.dim, letterSpacing: 3, textTransform: "uppercase" }}>
        {icon ? (
          <Img src={staticFile(icon)} style={{ width: 34, height: 34, borderRadius: "50%", objectFit: "cover", border: `1px solid ${C.grid}`, flex: "0 0 auto" }} />
        ) : null}
        <span>{k}</span>
      </div>
      <div style={{ fontSize: 50, color: c ?? C.fg, marginTop: 8, fontFamily: SANS, fontWeight: 600 }}>{v}</div>
    </div>
  );
}

/**
 * A scene built on a real dashboard capture.
 *
 * The panel sits in the upper band, letterboxed (`contain`) rather than cropped:
 * captures range from 4.45:1 (a chart row) to 16:9 (a full tab), and `cover`
 * on the wide ones threw away most of the chart — the exact thing the beat
 * exists to show. Caption sits below on solid ground so it never fights the
 * screenshot for contrast. Carries the same font and outro fade as `Stage`;
 * without that the overlay silently rendered in a serif fallback.
 */
export function ShotStage({
  file, label, children, zoom = 0.03, fit = "contain",
}: {
  file: string; label: string; children: React.ReactNode; zoom?: number;
  /** "contain" for a wide panel strip (shows all of it); "cover" for a full 16:9 tab (fills the band). */
  fit?: "contain" | "cover";
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = enter(frame, 0, 18);
  const drift = interpolate(frame, [0, durationInFrames], [1, 1 + zoom], { extrapolateRight: "clamp" });
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ fontFamily: MONO, color: C.fg, backgroundColor: C.bg, opacity: out }}>
      <div
        style={{
          position: "absolute", top: 0, left: 0, right: 0, height: "58%",
          // Inset so the slow push-in has room to grow without eating the
          // panel's own border and heading.
          padding: "40px 60px 0",
          overflow: "hidden", opacity: t, borderBottom: `1px solid ${C.grid}`,
        }}
      >
        <Img
          src={staticFile(file)}
          style={{
            width: "100%", height: "100%", objectFit: fit,
            // Anchor to the top: a dashboard tab puts its headline stats in the
            // first rows, and centring a `cover` crop threw exactly those away.
            objectPosition: "top center",
            scale: String(drift),
          }}
        />
      </div>
      {/* paddingBottom clears the corner label so the last caption line never collides with it. */}
      <AbsoluteFill style={{ padding: 96, paddingTop: 0, paddingBottom: 130, justifyContent: "flex-end" }}>
        {children}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute", left: 96, bottom: 52, display: "flex", gap: 14, alignItems: "center",
          fontSize: 24, letterSpacing: 5, color: C.dim, textTransform: "uppercase",
        }}
      >
        <span style={{ width: 11, height: 11, backgroundColor: C.green, borderRadius: 2 }} />
        {label}
      </div>
    </AbsoluteFill>
  );
}

/**
 * A scene built on a generated mascot card (scripts/mascot.mjs). The card is
 * composed with its subject right-of-centre and the left third empty, so the
 * copy sits in that gutter over a soft dark scrim — no letterbox, the
 * character fills the frame. Same font and outro fade as `Stage`; the last
 * time a scene skipped those the overlay rendered in a serif fallback.
 */
export function MascotStage({
  file, label, children,
}: { file: string; label: string; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = enter(frame, 0, 18);
  // A slow push-in keeps a still image from reading as a freeze-frame.
  const drift = interpolate(frame, [0, durationInFrames], [1.0, 1.04], { extrapolateRight: "clamp" });
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ fontFamily: MONO, color: C.fg, backgroundColor: C.bg, opacity: out }}>
      <AbsoluteFill style={{ opacity: t, overflow: "hidden" }}>
        <Img
          src={staticFile(file)}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", scale: String(drift) }}
        />
      </AbsoluteFill>
      {/* Scrim under the copy so white type holds on any card, without dimming the character. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(90deg, ${C.bg} 0%, ${C.bg}F0 30%, ${C.bg}99 44%, transparent 60%)`,
        }}
      />
      {/*
        The cards put their subject from ~40% of the width rightward, so the
        copy column stops at 40% and the scrim carries it. Anything wider ran
        the subtitle under the desk and the domain into the monitor.
      */}
      <AbsoluteFill style={{ padding: 96, paddingRight: 0, display: "flex", flexDirection: "column", justifyContent: "center", width: "40%" }}>
        {children}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute", left: 96, bottom: 52, display: "flex", gap: 14, alignItems: "center",
          fontSize: 24, letterSpacing: 5, color: C.dim, textTransform: "uppercase",
        }}
      >
        <span style={{ width: 11, height: 11, backgroundColor: C.green, borderRadius: 2 }} />
        {label}
      </div>
    </AbsoluteFill>
  );
}

/**
 * A token's icon beside its ticker. The icon is a local file fetched by
 * data.mjs (public/icons/<mint>.*) so the render is deterministic; when the
 * fetch failed `icon` is null and only the ticker renders — a bare ticker is
 * fine, a broken image is not. Icon is round with a hairline ring, matching
 * how the dashboard's position cards draw it.
 */
export function TokenBadge({
  symbol, icon, size = 120, color = C.fg, delay = 0,
}: { symbol: string; icon?: string | null; size?: number; color?: string; delay?: number }) {
  const frame = useCurrentFrame();
  const t = enter(frame, delay, 18);
  const iconPx = Math.round(size * 0.92);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: Math.round(size * 0.22), opacity: t, translate: `0px ${(1 - t) * 20}px` }}>
      {icon ? (
        <Img
          src={staticFile(icon)}
          style={{
            width: iconPx, height: iconPx, borderRadius: "50%", objectFit: "cover",
            border: `2px solid ${C.grid}`, backgroundColor: C.panel, flex: "0 0 auto",
          }}
        />
      ) : null}
      <div style={{ fontSize: size, lineHeight: 1, fontWeight: 600, letterSpacing: -3, fontFamily: SANS, color }}>
        {symbol}
      </div>
    </div>
  );
}
