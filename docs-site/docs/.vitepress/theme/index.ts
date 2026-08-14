import DefaultTheme from "vitepress/theme-without-fonts";
import type { Theme } from "vitepress";
import DashTokenGen from "./DashTokenGen.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("DashTokenGen", DashTokenGen);
  },
} satisfies Theme;
