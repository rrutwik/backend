/**
 * @description pm2 configuration file.
 * @example
 *  production mode :: pm2 start ecosystem.config.js --only prod
 *  development mode :: pm2 start ecosystem.config.js --only dev
 */
module.exports = {
  apps: [
    {
      name: 'prod',
      script: 'dist/server.js',
      exec_mode: 'cluster',
      instances: 2,
      autorestart: true,
      watch: false,
      wait_ready: true,
      listen_timeout: 10000,
      max_memory_restart: "500M",
      kill_timeout: 120 * 1000,
      merge_logs: true,
      output: './logs/access.log',
      error: './logs/error.log',
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        PORT: 3000,
        NODE_ENV: 'production',
      },
    },
  ]
};
