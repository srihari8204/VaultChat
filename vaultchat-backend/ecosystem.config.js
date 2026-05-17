// PM2 ecosystem file for VaultChat backend.
// Points at the bundled output from `npm run build`.
//
// Usage:
//   npm run build                          # produces dist/server.js
//   pm2 start ecosystem.config.js --env production
//   pm2 reload vaultchat-backend           # zero-downtime reload
//   pm2 logs vaultchat-backend
//   pm2 save && pm2 startup                # persist across reboots

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'vaultchat-backend',
      script: path.join(__dirname, 'dist', 'server.js'),
      cwd: path.join(__dirname, 'dist'),

      // Cluster mode lets Node use all CPU cores. Socket.IO needs sticky
      // sessions across workers — if you scale instances > 1, put nginx
      // (ip_hash) or use the @socket.io/cluster-adapter. Start with 1.
      instances: 1,
      exec_mode: 'fork',

      // Restart policy
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,

      // Logs (rotated by pm2-logrotate, install once: pm2 install pm2-logrotate)
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Graceful shutdown — give Socket.IO clients time to disconnect
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 10000,

      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Real secrets (EMAIL_USER, EMAIL_PASS, APP_URL,
        // GOOGLE_APPLICATION_CREDENTIALS) should come from the host's
        // shell env or a .env loaded by the process manager, not be
        // checked into this file.
      },
    },
  ],
};
