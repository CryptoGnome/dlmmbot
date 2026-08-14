export type WikiTone = "ok" | "warn" | "accent" | "danger" | "fg";

export type WikiBlock =
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "callout"; tone: WikiTone; title?: string; text: string };

export type WikiSection = {
  id: string;
  title: string;
  summary: string;
  blocks: WikiBlock[];
};
