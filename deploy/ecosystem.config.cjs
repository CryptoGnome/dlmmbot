// PM2 process definitions for the server.
// Usage:  pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
// Runtime config/env/db live under data/ (gitignored) so Settings never dirties git.
const path = require("path");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const runtimeEnv = {
  FARMER_ROOT: root,
  FARMER_CONFIG_PATH: path.join(dataDir, "config.toml"),
  FARMER_ENV_PATH: path.join(dataDir, ".env"),
  FARMER_DB_PATH: path.join(dataDir, "farmer.db"),
};

module.exports = {
  apps: [
    {
      name: "meteora-farmer",
      script: "npm",
      args: "run run",
      cwd: root,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: { ...runtimeEnv },
    },
    {
      name: "meteora-deploy",
      script: __dirname + "/auto-deploy.sh",
      interpreter: "bash",
      autorestart: true,
      restart_delay: 10000,
      env: {
        PATH: `${process.env.HOME}/.npm-global/bin:${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        PM2_BIN: `${process.env.HOME}/.npm-global/bin/pm2`,
      },
    },
    {
      name: "meteora-dash",
      script: __dirname + "/dashboard-server.mjs",
      cwd: root,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: {
        ...runtimeEnv,
        DASH_PORT: "8787",
        // DASH_TOKEN must be set in the process env / .env — never commit secrets.
      },
    },
  ],
};
