module.exports = {
  apps: [
    {
      name: "qa-agent",
      script: "bot.js",
      cwd: "D:\\\\QA_Agent",
      watch: false,
      ignore_watch: ["node_modules", "test-cache", "data", "screenshots"],
      env: {
        NODE_ENV: "production",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        CHCP: "65001"
      }
    }
  ]
};
