/**
 * context-loader.js
 * Smart context loader สำหรับ QA Agent v2
 */

const fs   = require("fs");
const path = require("path");

const MEMORY_PATH   = path.join(__dirname, "data", "memory.json");
const LOG_KEEP_DAYS = 7;

const INTENT_CONTEXT_MAP = {
  browser_test:    ["user", "activeProject", "scriptCache"],
  retest:          ["user", "activeProject", "recentLog"],
  test_history:    ["user", "activeProject", "recentLog"],
  jira_status:     ["user", "activeProject"],
  jira_toggle:     ["user", "activeProject"],
  jira_tasks:      ["user", "activeProject"],
  jira_overdue:    ["user", "activeProject"],
  switch_project:  ["user", "allProjects"],
  list_projects:   ["user", "allProjects"],
  add_project:     ["user", "allProjects"],
  daily_summary:   ["user", "activeProject", "recentLog", "recentJira"],
  what_today:      ["user", "activeProject", "recentLog"],
  what_tomorrow:   ["user", "activeProject"],
  remind:          ["user", "reminders"],
  general_qa:      ["user", "activeProject"],
  unknown:         ["user", "activeProject"],
};

function readMemory() {
  if (!fs.existsSync(MEMORY_PATH)) {
    const defaultMemory = { projects: {}, users: {}, log: [], reminders: [] };
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(defaultMemory, null, 2));
    return defaultMemory;
  }
  return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
}

function writeMemory(memory) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

function trimLog(log) {
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
  return log.filter((e) => new Date(e.ts).getTime() > cutoff);
}

const INTENT_PATTERNS = [
  { pattern: /\bretest\s+TC_\S+/i,                                             intent: "retest" },
  { pattern: /\btest\s+TC_\S+/i,                                               intent: "browser_test" },
  { pattern: /clear[\s_]?cache/i,                                               intent: "clear_cache" },
  { pattern: /ประวัติ.*TC|history.*TC|TC.*fail/i,                              intent: "test_history" },
  { pattern: /jira\s+(on|off)/i,                                                intent: "jira_toggle" },
  { pattern: /jira\s+status/i,                                                  intent: "jira_status" },
  { pattern: /งานค้าง|overdue|เกิน due/i,                                      intent: "jira_overdue" },
  { pattern: /มีงาน|มี task|งานวันนี้|to.?do/i,                               intent: "jira_tasks" },
  { pattern: /สลับ.*project|switch.*project|ใช้\s*project|เปลี่ยน.*project/i, intent: "switch_project" },
  { pattern: /project ทั้งหมด|list.*project|มี project/i,                     intent: "list_projects" },
  { pattern: /เพิ่ม.*project|add.*project|สร้าง.*project/i,                   intent: "add_project" },
  { pattern: /สรุปวันนี้|summary.*วัน|ทำอะไรไปบ้าง/i,                        intent: "daily_summary" },
  { pattern: /วันนี้มีอะไร|today.*งาน|งานวันนี้/i,                            intent: "what_today" },
  { pattern: /พรุ่งนี้มีอะไร|tomorrow|งานพรุ่งนี้/i,                          intent: "what_tomorrow" },
  { pattern: /remind|แจ้งเตือน|เตือนฉัน/i,                                   intent: "remind" },
];

function detectIntentFast(message) {
  const msg = message.trim();
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(msg)) return intent;
  }
  return "unknown";
}

function extractTcId(message) {
  const match = message.match(/TC_\S+/i);
  return match ? match[0].toUpperCase() : null;
}

function extractProjectName(message) {
  const match = message.match(/project\s+(\w+)|สลับ(?:ไป)?\s+(\w+)|ใช้\s+(\w+)/i);
  return match ? (match[1] || match[2] || match[3]).toUpperCase() : null;
}

function buildContext(userId, intent, memory) {
  const neededSections = INTENT_CONTEXT_MAP[intent] || INTENT_CONTEXT_MAP["unknown"];
  const ctx = {};

  if (neededSections.includes("user")) {
    const user = memory.users[userId] || {};
    ctx.user = {
      name:          user.name || "ไม่ทราบชื่อ",
      activeProject: user.activeProject || null,
      preferences:   user.preferences || {},
      lastSeen:      user.lastSeen || null,
    };
  }

  if (neededSections.includes("activeProject")) {
    const user    = memory.users[userId] || {};
    const projKey = user.activeProject;
    if (projKey && memory.projects[projKey]) {
      const p = memory.projects[projKey];
      ctx.activeProject = {
        key:       projKey,
        jiraKey:   p.jiraKey,
        epicId:    p.epicId,
        appUrl:    p.appUrl,
        excelPath: p.excelPath,
        jiraOn:    p.jiraOn !== false,
      };
    } else {
      ctx.activeProject = null;
    }
  }

  if (neededSections.includes("allProjects")) {
    ctx.allProjects = Object.entries(memory.projects).map(([key, p]) => ({
      key,
      jiraKey:  p.jiraKey,
      epicId:   p.epicId,
      hasExcel: !!p.excelPath,
    }));
  }

  if (neededSections.includes("recentLog")) {
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    ctx.recentLog = memory.log
      .filter((e) => e.userId === userId && new Date(e.ts).getTime() > cutoff24h)
      .slice(-20)
      .map((e) => ({ ts: e.ts, action: e.action, tc: e.tc, result: e.result, note: e.note }));
  }

  if (neededSections.includes("scriptCache")) {
    const cacheDir = path.join(__dirname, "cache");
    if (fs.existsSync(cacheDir)) {
      ctx.cachedTCs = fs.readdirSync(cacheDir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => f.replace(".js", ""));
    } else {
      ctx.cachedTCs = [];
    }
  }

  if (neededSections.includes("reminders")) {
    const now = Date.now();
    ctx.reminders = (memory.reminders || [])
      .filter((r) => r.userId === userId && new Date(r.dueAt).getTime() > now)
      .slice(0, 10);
  }

  return ctx;
}

function buildSystemPrompt(ctx, intent) {
  const userName    = ctx.user?.name || "ทีม QA";
  const projectName = ctx.activeProject?.key || "ยังไม่ได้เลือก project";

  let prompt = `คุณคือเลขาส่วนตัวของ ${userName} ทีม QA
ตอบภาษาไทยเป็นหลัก กระชับ ตรงประเด็น เป็นกันเอง แต่ professional
ถ้าไม่รู้ข้อมูลอะไรบอกตรงๆ อย่าเดา

=== Context ปัจจุบัน ===
ผู้ใช้: ${userName}
Active project: ${projectName}
Intent ที่ตรวจพบ: ${intent}
`;

  if (ctx.activeProject) {
    prompt += `
=== Project Config ===
Jira Key: ${ctx.activeProject.jiraKey}
Epic ID: ${ctx.activeProject.epicId}
App URL: ${ctx.activeProject.appUrl}
Jira Update: ${ctx.activeProject.jiraOn ? "เปิด" : "ปิด"}
`;
  }

  if (ctx.recentLog?.length > 0) {
    prompt += `
=== กิจกรรมล่าสุด (24 ชม.) ===
${ctx.recentLog.map((e) => `[${e.ts}] ${e.action} ${e.tc || ""} → ${e.result || ""} ${e.note || ""}`).join("\n")}
`;
  }

  if (ctx.allProjects?.length > 0) {
    prompt += `
=== Projects ทั้งหมด ===
${ctx.allProjects.map((p) => `- ${p.key} (Jira: ${p.jiraKey}, Epic: ${p.epicId})`).join("\n")}
`;
  }

  if (ctx.reminders?.length > 0) {
    prompt += `
=== Reminders ที่ยังไม่ถึงเวลา ===
${ctx.reminders.map((r) => `- ${r.text} (due: ${r.dueAt})`).join("\n")}
`;
  }

  if (ctx.cachedTCs?.length > 0) {
    prompt += `
=== Script Cache (TC ที่มีอยู่แล้ว ไม่ต้อง generate ใหม่) ===
${ctx.cachedTCs.join(", ")}
`;
  }

  return prompt;
}

// ─────────────────────────────────────────────
// MEMORY WRITE HELPERS
// ─────────────────────────────────────────────

function logAction(userId, action, extras = {}) {
  const memory = readMemory();
  memory.log = trimLog(memory.log);
  memory.log.push({ ts: new Date().toISOString(), userId, action, ...extras });
  writeMemory(memory);
}

function switchProject(userId, projectKey) {
  const memory = readMemory();
  if (!memory.projects[projectKey]) {
    return { ok: false, error: `ไม่เจอ project "${projectKey}" ใน memory` };
  }
  if (!memory.users[userId]) memory.users[userId] = {};
  memory.users[userId].activeProject = projectKey;
  memory.users[userId].lastSeen      = new Date().toISOString();
  writeMemory(memory);
  return { ok: true, project: memory.projects[projectKey] };
}

function upsertUser(userId, profile = {}) {
  const memory = readMemory();
  if (!memory.users[userId]) memory.users[userId] = {};
  Object.assign(memory.users[userId], profile, { lastSeen: new Date().toISOString() });
  writeMemory(memory);
}

function addProject(projectData) {
  const memory = readMemory();
  const key    = projectData.key.toUpperCase();
  memory.projects[key] = {
    jiraKey:   projectData.jiraKey || key,
    epicId:    projectData.epicId,
    appUrl:    projectData.appUrl,
    excelPath: projectData.excelPath || null,
    jiraOn:    true,
  };
  writeMemory(memory);
  return { ok: true, key };
}

function toggleJira(userId, onOff) {
  const memory  = readMemory();
  const projKey = memory.users[userId]?.activeProject;
  if (!projKey || !memory.projects[projKey]) {
    return { ok: false, error: "ยังไม่ได้เลือก active project" };
  }
  memory.projects[projKey].jiraOn = onOff;
  writeMemory(memory);
  return { ok: true, jiraOn: onOff, project: projKey };
}

function addReminder(userId, text, dueAt) {
  const memory = readMemory();
  if (!memory.reminders) memory.reminders = [];
  memory.reminders.push({ userId, text, dueAt, createdAt: new Date().toISOString() });
  writeMemory(memory);
}

/**
 * setExcelPath — บันทึก excelPath ลง memory สำหรับ project ที่ระบุ
 */
function setExcelPath(userId, projectKey, excelPath) {
  const memory = readMemory();
  const key    = projectKey.toUpperCase();
  if (!memory.projects[key]) {
    return { ok: false, error: `ไม่เจอ project "${key}"` };
  }
  memory.projects[key].excelPath = excelPath;
  writeMemory(memory);
  console.log(`[setExcelPath] ${key} → ${excelPath}`);
  return { ok: true, project: key, excelPath };
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

function load(userId, message) {
  const memory       = readMemory();
  const intent       = detectIntentFast(message);
  const tcId         = extractTcId(message);
  const projectName  = extractProjectName(message);
  const ctx          = buildContext(userId, intent, memory);
  const systemPrompt = buildSystemPrompt(ctx, intent);

  upsertUser(userId, {});

  return { intent, tcId, projectName, context: ctx, systemPrompt };
}

module.exports = {
  load,
  logAction,
  switchProject,
  upsertUser,
  addProject,
  toggleJira,
  addReminder,
  setExcelPath,
  readMemory,
  writeMemory,
  detectIntentFast,
  extractTcId,
};