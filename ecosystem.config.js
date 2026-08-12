module.exports = {
  apps: [
    {
      name: 'fundanalysis',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
      },
      // 其余配置（端口、密钥）从同目录 .env 读取，避免密钥进入代码库
      out_file: './data/pm2-out.log',
      error_file: './data/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
