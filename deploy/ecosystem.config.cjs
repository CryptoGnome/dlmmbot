// PM2 process definitions for the server.
// Usage:  pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "meteora-farmer",
      script: "npm",
      args: "run run",
      cwd: __dirname + "/..",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      // The farmer's single-instance lock reclaims stale locks from dead PIDs,
      // so PM2 crash-restarts recover cleanly.
    },
    {
      name: "meteora-deploy",
      script: __dirname + "/auto-deploy.sh",
      interpreter: "bash",
      autorestart: true,
      restart_delay: 10000,
    },
  ],
};
