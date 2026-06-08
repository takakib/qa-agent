// ============================================================
// config.js — แก้ไขไฟล์นี้ไฟล์เดียวพอ ไม่ต้องแตะ code อื่น
// ============================================================

module.exports = {
  // ── Discord Channel ───────────────────────────────────────
  // Channel ID ที่ให้ bot ตอบโดยไม่ต้อง mention
  // วิธีหา: Discord → Settings → Advanced → Developer Mode
  //         แล้ว right-click ชื่อ channel → Copy Channel ID
  ALLOWED_CHANNELS: [
    "1499304351146184856", // แก้เป็น channel ID ของคุณ
  ],

  // ── Jira Users ────────────────────────────────────────────
  // เพิ่ม user ของทีมตรงนี้
  // หา jiraAccountId: node get-jira-id.js
  // หา discordUserId: right-click ชื่อ user ใน Discord → Copy User ID
  USERS: [
    {
      name:          "Bird QA",
      jiraAccountId: "712020:0d2b1187-45f8-41a8-b263-2e1da40067aa",
      discordUserId: "ใส่ discord user id ของ Bird QA",
    },
    // เพิ่ม user อื่นได้เรื่อยๆ แบบนี้
    // {
    //   name:          "John QA",
    //   jiraAccountId: "xxxxxx:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    //   discordUserId: "xxxxxxxxxxxxxxxxxxxx",
    // },
  ],
};
