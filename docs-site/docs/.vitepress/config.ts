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
  ],
  themeConfig: {
    logo: undefined,
    siteTitle: "dlmmbot",
    nav: [
      { text: "Home", link: "https://dlmmbot.com/" },
      { text: "Easy (Railway)", link: "/easy" },
      { text: "Advanced", link: "/advanced" },
      { text: "Profiles", link: "/profiles" },
      { text: "Strategy", link: "https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md" },
      { text: "GitHub", link: "https://github.com/CryptoGnome/dlmmbot" },
    ],
    sidebar: [
      {
        text: "Setup",
        items: [
          { text: "Choose a path", link: "/" },
          { text: "Easy — Railway", link: "/easy" },
          { text: "Advanced — local / VPS", link: "/advanced" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Settings profiles", link: "/profiles" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "STRATEGY.md", link: "https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md" },
          { text: "DEPLOY.md", link: "https://github.com/CryptoGnome/dlmmbot/blob/master/DEPLOY.md" },
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
