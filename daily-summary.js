// ============================================================
// daily-summary.js — Daily Summary + Scheduler สำหรับ QA Agent v2
// ============================================================

const contextLoader  = require("./context-loader");
const { execSync }   = require("child_process");
const path           = require("path");
const fs             = require("fs");
const os             = require("os");

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function todayRange() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);
  return { start, end };
}

function isToday(tsStr) {
  const { start, end } = todayRange();
  const ts = new Date(tsStr);
  return ts >= start && ts <= end;
}

function isThisWeek(tsStr) {
  const ts  = new Date(tsStr);
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  return ts >= weekAgo && ts <= now;
}

function formatTime(tsStr) {
  return new Date(tsStr).toLocaleTimeString("th-TH", {
    timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit",
  });
}

// เวลา ณ ปัจจุบันใน Asia/Bangkok — คืน { hhmm: "09:00", weekday: "Mon" }
// ใช้แทน now.getHours() เพื่อไม่ให้ผลลัพธ์ผูกกับ timezone ของเครื่องที่รัน
function bangkokNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  // hour12:false บางรันไทม์คืน "24" ตอนเที่ยงคืน → normalize เป็น "00"
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { hhmm: `${hour}:${parts.minute}`, weekday: parts.weekday };
}

// ─────────────────────────────────────────────
// READ EXCEL TC PROGRESS
// ─────────────────────────────────────────────

function findPython() {
  for (const cmd of ["python", "python3", "py"]) {
    try { execSync(`${cmd} --version`, { stdio: "ignore" }); return cmd; } catch {}
  }
  return null;
}

function readExcelProgress(excelPath) {
  if (!excelPath || !fs.existsSync(excelPath)) return null;

  const PYTHON = findPython();
  if (!PYTHON) return null;

  const script = path.join(os.tmpdir(), "qa_progress.py");
  fs.writeFileSync(script, [
    "# -*- coding: utf-8 -*-",
    "import sys, io, json",
    "sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')",
    "import pandas as pd",
    `df = pd.read_excel(r'${excelPath.replace(/\\/g, "\\\\")}', sheet_name='Test Case', header=2)`,
    "total = pass_count = fail_count = not_run = 0",
    "for i, row in df.iterrows():",
    "    tc_id = str(row.get('Test Case\\nID', '') or '').strip()",
    "    if not tc_id or tc_id == 'nan': continue",
    "    total += 1",
    "    status = str(row.get('Scenario\\nStatus', '') or '').strip().upper()",
    "    if status == 'PASS': pass_count += 1",
    "    elif status == 'FAIL': fail_count += 1",
    "    else: not_run += 1",
    "print(json.dumps({'total': total, 'pass': pass_count, 'fail': fail_count, 'not_run': not_run}))",
  ].join("\n"), "utf8");

  try {
    const result = execSync(`${PYTHON} "${script}"`, {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      timeout: 15000,
    });
    return JSON.parse(result.trim());
  } catch (e) {
    console.error("[EXCEL PROGRESS] error:", e.message);
    return null;
  }
}

function formatProgress(progress) {
  if (!progress) return null;
  const { total, pass, fail, not_run } = progress;
  const done    = pass + fail;
  const pct     = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar     = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  return [
    `**📊 TC Progress [${pct}%]**`,
    `${bar} ${done}/${total} TC`,
    `✅ Pass: ${pass} | ❌ Fail: ${fail} | ⬜ Not Run: ${not_run}`,
    not_run > 0 ? `⏳ เหลืออีก ${not_run} TC ที่ยังไม่ได้รัน` : "🎉 รันครบทุก TC แล้วครับ!",
  ].join("\n");
}

// ─────────────────────────────────────────────
// BUILD SUMMARY จาก log
// ─────────────────────────────────────────────

function buildSummaryData(userId, range = "today") {
  const memory  = contextLoader.readMemory();
  const user    = memory.users[userId] || {};
  const project = user.activeProject || "ไม่ระบุ";
  const log     = memory.log || [];

  const filterFn = range === "week" ? isThisWeek : isToday;
  const entries  = log.filter(e => e.userId === userId && filterFn(e.ts));

  const tests       = entries.filter(e => e.action === "browser_test" || e.action === "retest");
  const jiraActions = entries.filter(e => ["jira_tasks","jira_overdue","update_issue"].includes(e.action));
  const switches    = entries.filter(e => e.action === "switch_project");
  const generals    = entries.filter(e => e.action === "general");

  const passed   = tests.filter(e => e.result === "pass");
  const failed   = tests.filter(e => e.result === "fail");
  const retested = tests.filter(e => e.action === "retest");
  const uniqueTC = [...new Set(tests.map(e => e.tc).filter(Boolean))];

  // อ่าน Excel progress
  const excelPath  = memory.projects?.[project]?.excelPath || null;
  const excelProgress = readExcelProgress(excelPath);

  return {
    user, project, range,
    entries, tests, jiraActions, switches, generals,
    passed, failed, retested, uniqueTC,
    totalActions: entries.length,
    excelProgress,
    excelPath,
  };
}

// ─────────────────────────────────────────────
// FORMAT สรุปเป็น Discord message
// ─────────────────────────────────────────────

function formatSummary(data, mode = "normal") {
  const { user, project, range, passed, failed, retested, uniqueTC,
          jiraActions, switches, generals, totalActions, excelProgress } = data;
  const rangeLabel = range === "week" ? "สัปดาห์นี้" : "วันนี้";
  const now = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short",
  });

  const lines = [`📋 **สรุป${rangeLabel}** — ${user.name || "คุณ"} [${project}]`];
  lines.push(`🕐 อัพเดทเมื่อ ${now}`);
  lines.push("");

  // ── Excel TC Progress ──
  if (excelProgress) {
    lines.push(formatProgress(excelProgress));
    lines.push("");
  }

  // ── วันนี้รันไป ──
  if (uniqueTC.length > 0) {
    lines.push(`**🧪 วันนี้รันไป — ${uniqueTC.length} TC**`);
    lines.push(`✅ Pass: ${passed.length} | ❌ Fail: ${failed.length} | 🔁 Retest: ${retested.length}`);

    if (passed.length > 0) {
      lines.push(`\n_Pass:_`);
      passed.forEach(e => lines.push(`  • ${e.tc}${e.project ? ` [${e.project}]` : ""} — ${formatTime(e.ts)}`));
    }
    if (failed.length > 0) {
      lines.push(`\n_Fail:_`);
      failed.forEach(e => lines.push(`  • ${e.tc}${e.project ? ` [${e.project}]` : ""} — ${formatTime(e.ts)}`));
    }
    lines.push("");
  } else if (totalActions === 0 && !excelProgress) {
    lines.push(`_ยังไม่มีกิจกรรม${rangeLabel}ครับ_ 😴`);
    lines.push(`\nพิมพ์ \`test TC_xxx\` เพื่อเริ่มทดสอบได้เลยครับ`);
    return lines.join("\n");
  }

  // ── Jira actions ──
  if (jiraActions.length > 0) {
    lines.push(`**📌 Jira — ${jiraActions.length} actions**`);
    jiraActions.slice(0, 5).forEach(e => {
      const label = { jira_tasks: "ดู tasks", jira_overdue: "ดู overdue", update_issue: "update card" }[e.action] || e.action;
      lines.push(`  • ${label}${e.note ? ` — ${e.note.slice(0, 40)}` : ""}`);
    });
    lines.push("");
  }

  // ── Project switches ──
  if (switches.length > 0) {
    lines.push(`**🔀 สลับ project — ${switches.length} ครั้ง**`);
    switches.forEach(e => lines.push(`  • → ${e.project} — ${formatTime(e.ts)}`));
    lines.push("");
  }

  // ── คำถามทั่วไป ──
  if (generals.length > 0 && mode === "detailed") {
    lines.push(`**💬 คำถามทั่วไป — ${generals.length} ครั้ง**`);
    generals.slice(0, 5).forEach(e => lines.push(`  • ${e.note?.slice(0, 50) || "—"}`));
    lines.push("");
  }

  if (totalActions > 0) {
    lines.push(`**รวม ${totalActions} actions ${rangeLabel}ครับ**`);
  }

  // ── motivational line ──
  if (excelProgress?.not_run === 0 && excelProgress?.total > 0) {
    lines.push("🎉 รันครบทุก TC แล้ว ยอดเยี่ยมมากครับ!");
  } else if (passed.length > 0 && failed.length === 0) {
    lines.push("🎉 วันนี้ผ่านทุกอันเลย ยอดเยี่ยมครับ!");
  } else if (failed.length > 0) {
    lines.push(`💪 มี ${failed.length} TC ที่ยังค้างอยู่นะครับ ไว้แก้ต่อได้เลย`);
  } else if (totalActions > 0 || excelProgress) {
    lines.push("👍 ทำงานมาดีครับวันนี้");
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// MORNING BRIEF
// ─────────────────────────────────────────────

function formatMorningBrief(userId) {
  const memory  = contextLoader.readMemory();
  const user    = memory.users[userId] || {};
  const project = user.activeProject || "ไม่ระบุ";

  const now      = new Date();
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const dueToday = (memory.reminders || []).filter(r =>
    r.userId === userId &&
    new Date(r.dueAt) >= now &&
    new Date(r.dueAt) <= todayEnd
  );

  const lines = [
    `☀️ **อรุณสวัสดิ์ครับ ${user.name || "คุณ"}!**`,
    `📁 Active project: **${project}**`,
    "",
  ];

  // Excel progress ตอนเช้า
  const excelPath = memory.projects?.[project]?.excelPath || null;
  const progress  = readExcelProgress(excelPath);
  if (progress) {
    lines.push(formatProgress(progress));
    lines.push("");
  }

  if (dueToday.length > 0) {
    lines.push(`**⏰ Reminders วันนี้ (${dueToday.length})**`);
    dueToday.forEach(r => lines.push(`  • ${r.text} — ${formatTime(r.dueAt)}`));
    lines.push("");
  }

  lines.push("พิมพ์ `มีงานอะไรบ้าง` เพื่อดู Jira tasks ของวันนี้ได้เลยครับ 🚀");

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// MORNING BRIEF — Jira tasks ที่ยังไม่ Done ของ project RDT
// ดึงด้วย handleToTestReport (TO TEST) + handleBugReport (Bug ค้าง) แล้วจัดกลุ่มตาม status
// ─────────────────────────────────────────────

// require แบบ lazy กัน load-order/circular ตอน daily-summary ถูก import เดี่ยวๆ
function getAgent() {
  return require("./claude-agent");
}

async function buildRdtMorningBrief() {
  const agent = getAgent();
  // handleBugReport hardcode RDT อยู่แล้ว ส่วน handleToTestReport อ่าน jiraKey จาก ctx → บังคับเป็น RDT
  const ctx = { activeProject: { key: "RDT", jiraKey: "RDT" } };

  const [toTest, bugText] = await Promise.all([
    agent.handleToTestReport(ctx),
    agent.handleBugReport(ctx),
  ]);

  const dateLabel = new Date().toLocaleDateString("th-TH", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric",
  });
  const lines = [`🌅 **Morning Brief — RDT** (${dateLabel})`, ""];

  // ── กลุ่ม status: TO TEST ──
  if (toTest.error) {
    lines.push(toTest.error, "");
  } else {
    const items = (toTest.epics || []).flatMap(ep => [...ep.mine, ...ep.others]);
    lines.push(`🧪 **TO TEST — ${toTest.total} งาน**`);
    if (items.length === 0) {
      lines.push("  _ไม่มีงานสถานะ TO TEST ครับ_");
    } else {
      items.slice(0, 20).forEach(it =>
        lines.push(`  • ${it.key} \`${it.priority}\` — ${(it.summary || "").slice(0, 55)}`)
      );
      if (items.length > 20) lines.push(`  ...และอีก ${items.length - 20} งาน`);
    }
    lines.push("");
  }

  // ── กลุ่ม status อื่นๆ: Bug ค้าง (handleBugReport คืน string ที่จัดกลุ่มตาม status มาแล้ว) ──
  lines.push(bugText);

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

async function handleSummary(userId, ctx, options = {}) {
  const range = options.range || "today";
  const mode  = options.mode  || "normal";
  const data  = buildSummaryData(userId, range);
  return formatSummary(data, mode);
}

// ─────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────

function startScheduler(client) {
  console.log("[SCHEDULER] Daily report scheduler เริ่มทำงานแล้วครับ");

  const sentToday = { morning: new Set(), evening: new Set(), rdtBrief: false };

  setInterval(async () => {
    const now  = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    const today = now.toDateString();
    const bkk  = bangkokNow(); // เวลา/วัน ตาม Asia/Bangkok สำหรับ RDT morning brief

    if (sentToday._date !== today) {
      sentToday._date    = today;
      sentToday.morning  = new Set();
      sentToday.evening  = new Set();
      sentToday.rdtBrief = false;
    }

    const memory = contextLoader.readMemory();
    const users  = memory.users || {};

    // ── Reminders ที่ถึงเวลา ─────────────────────────────
    await checkAndSendReminders(client, memory);

    // ── RDT Morning Brief: จันทร์-ศุกร์ 09:00 Asia/Bangkok, ส่ง DM ทุก user ─────────
    const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(bkk.weekday);
    if (isWeekday && bkk.hhmm === "09:00" && !sentToday.rdtBrief) {
      sentToday.rdtBrief = true; // กัน setInterval ยิงซ้ำภายในนาทีเดียวกัน
      try {
        const msg     = await buildRdtMorningBrief();
        const userIds = Object.keys(users);
        for (const userId of userIds) {
          await client.users.fetch(userId)
            .then(u => u.send(msg))
            .catch(e => console.error(`[RDT BRIEF] DM ${userId} ล้มเหลว:`, e.message));
        }
        console.log(`[SCHEDULER] RDT morning brief → ${userIds.length} users`);
      } catch (e) {
        console.error("[SCHEDULER] RDT brief error:", e.message);
      }
    }

    for (const [userId, user] of Object.entries(users)) {
      const reportTime  = user.preferences?.reportTime   || "09:00";
      const eveningTime = user.preferences?.eveningReport || "17:00";

      if (hhmm === reportTime && !sentToday.morning.has(userId)) {
        sentToday.morning.add(userId);
        try {
          const msg  = formatMorningBrief(userId);
          const chan = await findUserChannel(client, userId);
          if (chan) await chan.send(msg);
          console.log(`[SCHEDULER] Morning brief → ${user.name}`);
        } catch (e) { console.error("[SCHEDULER] Morning error:", e.message); }
      }

      if (hhmm === eveningTime && !sentToday.evening.has(userId)) {
        sentToday.evening.add(userId);
        try {
          const data = buildSummaryData(userId, "today");
          const msg  = formatSummary(data, "detailed");
          const chan = await findUserChannel(client, userId);
          if (chan) await chan.send(msg);
          console.log(`[SCHEDULER] Evening summary → ${user.name}`);
        } catch (e) { console.error("[SCHEDULER] Evening error:", e.message); }
      }
    }
  }, 60 * 1000);
}

async function checkAndSendReminders(client, memory) {
  const reminders = memory.reminders || [];
  if (reminders.length === 0) return;

  const now  = Date.now();
  const due  = [];
  const keep = [];
  for (const r of reminders) {
    if (new Date(r.dueAt).getTime() <= now) due.push(r);
    else keep.push(r);
  }
  if (due.length === 0) return;

  for (const r of due) {
    try {
      const u = await client.users.fetch(r.userId);
      const dueLocal = new Date(r.dueAt).toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short",
      });
      await u.send(`⏰ **เตือนความจำ**\n${r.text}\n📅 ${dueLocal}`);
      console.log(`[REMINDER] sent → ${r.userId}: ${r.text}`);
    } catch (e) {
      console.error(`[REMINDER] send failed (${r.userId}):`, e.message);
    }
  }

  memory.reminders = keep;
  contextLoader.writeMemory(memory);
}

async function findUserChannel(client, userId) {
  try {
    const user = await client.users.fetch(userId);
    return await user.createDM();
  } catch {
    const config = require("./config");
    const chanId = config.ALLOWED_CHANNELS?.[0];
    if (chanId) return client.channels.cache.get(chanId);
    return null;
  }
}

module.exports = {
  handleSummary,
  startScheduler,
  buildSummaryData,
  formatSummary,
  formatMorningBrief,
  buildRdtMorningBrief,
  bangkokNow,
};