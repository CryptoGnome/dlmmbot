export type WikiTone = "ok" | "warn" | "accent" | "danger" | "fg";

/** Lucide icon keys resolved in the Wiki page renderer. */
export type WikiIconKey =
  | "radar"
  | "shield"
  | "coins"
  | "chart"
  | "exit"
  | "bank"
  | "bot"
  | "boxes"
  | "layers"
  | "scan"
  | "entry"
  | "priority"
  | "follow"
  | "scale"
  | "ban"
  | "layout"
  | "refresh"
  | "calc"
  | "alert"
  | "book"
  | "zap"
  | "lock"
  | "play"
  | "pause"
  | "check"
  | "x";

export type WikiBlock =
  | { type: "tldr"; text: string }
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "callout"; tone: WikiTone; title?: string; text: string }
  | {
      type: "flow";
      title?: string;
      steps: { label: string; detail?: string; icon?: WikiIconKey; tone?: WikiTone }[];
    }
  | {
      type: "steps";
      items: { title: string; text: string; icon?: WikiIconKey }[];
    }
  | {
      type: "cards";
      items: { title: string; text: string; badge?: string; tone?: WikiTone; icon?: WikiIconKey }[];
    }
  | {
      type: "ladder";
      title?: string;
      items: { code: string; title: string; when: string; then: string; tone: WikiTone }[];
    };

export type WikiSection = {
  id: string;
  title: string;
  /** One plain sentence — what a brand-new user should remember. */
  simple: string;
  summary: string;
  icon: WikiIconKey;
  blocks: WikiBlock[];
};
