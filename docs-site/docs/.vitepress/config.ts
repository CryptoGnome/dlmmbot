import { defineConfig } from "vitepress";

export default defineConfig({
  title: "DLMM Bot",
  description: "Setup docs for DLMM Bot — Railway easy path or local / VPS advanced.",
  base: "/setup/",
  outDir: "../../docs/setup",
  cleanUrls: true,
  ignoreDeadLinks: true,
  appearance: "force-dark",
  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,650;1,500&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
    ["meta", { name: "theme-color", content: "#0D0D0D" }],
    [
      "script",
      {
        defer: "",
        src: "https://cloud.umami.is/script.js",
        "data-website-id": "3499aa8b-8f9b-4993-8bd5-6b660bebaff6",
      },
    ],
  ],
  themeConfig: {
    logo: { src: "/logo.svg", width: 24, height: 24 },
    siteTitle: "dlmmbot",
    nav: [
      { text: "Home", link: "https://dlmmbot.com/" },
      { text: "Easy (Railway)", link: "/easy" },
      { text: "API keys", link: "/api-keys" },
      { text: "How it works", link: "/how-it-works" },
      { text: "Strategy", link: "/strategy" },
      { text: "Risk", link: "/risk" },
      { text: "Fees", link: "/fees" },
      { text: "FAQ", link: "/faq" },
      { text: "GitHub", link: "https://github.com/CryptoGnome/dlmmbot" },
    ],
    sidebar: [
      {
        text: "Setup",
        items: [
          { text: "Choose a path", link: "/" },
          { text: "Easy — Railway", link: "/easy" },
          { text: "Advanced — local / VPS", link: "/advanced" },
          { text: "API keys", link: "/api-keys" },
          { text: "Settings profiles", link: "/profiles" },
        ],
      },
      {
        text: "Understanding the bot",
        items: [
          { text: "How it works", link: "/how-it-works" },
          { text: "Strategy reference", link: "/strategy" },
          { text: "Risk & sizing", link: "/risk" },
          { text: "Fees", link: "/fees" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/configuration" },
          { text: "Dashboard guide", link: "/dashboard" },
          { text: "CLI", link: "/cli" },
          { text: "FAQ", link: "/faq" },
          { text: "STRATEGY.md (repo)", link: "https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md" },
          { text: "DEPLOY.md (repo)", link: "https://github.com/CryptoGnome/dlmmbot/blob/master/DEPLOY.md" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/CryptoGnome/dlmmbot" },
    ],
    footer: {
      message: "Paper first. Burner only. Not financial advice.",
      copyright: "DLMM Bot",
    },
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
      label: "On this page",
    },
    editLink: {
      pattern: "https://github.com/CryptoGnome/dlmmbot/edit/master/docs-site/docs/:path",
      text: "Edit this page",
    },
    lastUpdated: {
      text: "Updated",
    },
  },
});
