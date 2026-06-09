// ============================================================
// bot.js — Discord Client v2 (multi-project + personal assistant)
// ============================================================
require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { askClaude: handleMessage, getTcStatusFromExcel, getExcelPath, findLatestExcel } = require("./claude-agent");
const contextLoader                 = require("./context-loader");
const { handleSummary, startScheduler } = require("./daily-summary");
const config                        = require("./config");
const path                          = require("path");
const fs                            = require("fs");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_MAX   = 1900;

const processedIds   = new Set();
const waitingConfirm = new Set();

// ── Thai reminder parser ──────────────────────────────────
// รองรับ: 'เตือนฉัน <ข้อความ> พรุ่งนี้ 10 โมง' / 'เตือนฉัน <ข้อความ> วันนี้ 14:00'
//          เพิ่ม: มะรืน, X โมง Y นาที, X:Y, ทุ่ม, นาฬิกา
function parseReminder(raw) {
  let body = String(raw || "")
    .replace(/^(เตือนฉัน|เตือนหน่อย|เตือน|แจ้งเตือน|remind\s+me|remind)\s*(?:ว่า|to)?\s*/i, "")
    .trim();
  if (!body) return null;

  const timeRe =
    /\s*(วันนี้|พรุ่งนี้|มะรืน|today|tomorrow)?\s*(?:ตอน|เวลา|at)?\s*(\d{1,2})(?::(\d{2})|\s*โมง(?:\s*(\d{1,2})\s*นาที)?|\s*ทุ่ม|\s*นาฬิกา)?\s*$/i;

  const m = body.match(timeRe);
  if (!m || m[2] === undefined) return null;

  const dayWord = (m[1] || "").toLowerCase();
  const matched = m[0];
  const isThung = /ทุ่ม/.test(matched);

  let hour   = parseInt(m[2], 10);
  let minute = m[3] !== undefined ? parseInt(m[3], 10) : (m[4] !== undefined ? parseInt(m[4], 10) : 0);

  if (isThung && hour >= 1 && hour <= 6) hour += 18;          // 1 ทุ่ม = 19
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const text = body.slice(0, m.index).replace(/[,，]$/, "").trim();
  if (!text) return null;

  const due = new Date();
  if (/พรุ่งนี้|tomorrow/.test(dayWord))      due.setDate(due.getDate() + 1);
  else if (/มะรืน/.test(dayWord))             due.setDate(due.getDate() + 2);
  due.setHours(hour, minute, 0, 0);

  if (!dayWord && due.getTime() < Date.now()) {
    due.setDate(due.getDate() + 1);                            // เวลาผ่านไปแล้ว → เลื่อนเป็นพรุ่งนี้
  }

  return { text, dueAt: due.toISOString() };
}

function splitMessage(text) {
  const lines  = text.split("\n");
  const chunks = [];
  let current  = "";
  for (const line of lines) {
    if ((current + "\n" + line).length <= DISCORD_MAX) {
      current = current ? current + "\n" + line : line;
    } else {
      if (line.length > DISCORD_MAX) {
        if (current) { chunks.push(current); current = ""; }
        for (let i = 0; i < line.length; i += DISCORD_MAX)
          chunks.push(line.slice(i, i + DISCORD_MAX));
      } else {
        if (current) chunks.push(current);
        current = line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendLong(message, text) {
  const fileMatch = text.match(/__FILE__:(.+)/);
  const cleanText = fileMatch ? text.replace(/__FILE__:.+/, "").trim() : text;
  const chunks    = splitMessage(cleanText);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) await message.reply({ content: chunks[i] });
    else         await message.channel.send({ content: chunks[i] });
  }
  if (fileMatch) {
    await message.channel.send({ files: [fileMatch[1].trim()] });
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", (c) => {
  console.log(`QA Agent พร้อมใช้งาน — logged in as ${c.user.tag}`);
  startScheduler(client);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (processedIds.has(message.id)) {
    console.log(`[SKIP] duplicate message.id: ${message.id}`);
    return;
  }
  processedIds.add(message.id);
  if (processedIds.size > 1000) processedIds.clear();

  const isMentioned      = message.mentions.has(client.user);
  const isDM             = message.channel.type === 1;
  const isAllowedChannel = config.ALLOWED_CHANNELS.includes(message.channel.id);

  console.log(`[MSG] from: ${message.author.tag} (${message.author.id}) | content: "${message.content}"`);

  if (!isMentioned && !isDM && !isAllowedChannel) return;

  const userMessage   = message.content.replace(/<@!?\d+>/g, "").trim();
  const discordUserId = message.author.id;

  const loaded = contextLoader.load(discordUserId, userMessage || "__ping__");
  const { intent, tcId, projectName, context, systemPrompt } = loaded;

  console.log(`[CTX] intent: ${intent} | project: ${context.activeProject?.key || "-"} | user: ${context.user?.name || "-"}`);

  // ── Excel attachment ───────────────────────────────────────
  const excelAttachment = message.attachments.find(a =>
    a.name.endsWith(".xlsx") || a.name.endsWith(".xls")
  );

  if (excelAttachment) {
    waitingConfirm.add(discordUserId);
    await message.channel.sendTyping();

    const currentProject = context.activeProject?.key || null;
    const currentExcel   = context.activeProject?.excelPath || null;

    // ── ถามยืนยันก่อน ──────────────────────────────────────
    if (currentProject) {
      const confirmMsg = [
        `📎 ได้รับไฟล์ **${excelAttachment.name}** แล้วครับ`,
        ``,
        `จะให้ทำอะไรกับไฟล์นี้ครับ?`,
        ``,
        `**1️⃣  Match + บันทึกเป็น Excel ของ project ${currentProject}**`,
        `   → Match TC กับ Jira แล้วบันทึก path ไว้ใช้ test ต่อไป`,
        currentExcel
          ? `   ⚠️ จะแทนที่ไฟล์เดิม: \`${path.basename(currentExcel)}\``
          : `   (ยังไม่มีไฟล์เดิม)`,
        ``,
        `**2️⃣  Match อย่างเดียว ไม่บันทึก path**`,
        `   → Match แล้วส่งไฟล์คืน ไม่เปลี่ยน config`,
        ``,
        `พิมพ์ **1** หรือ **2** ภายใน 60 วินาทีครับ`,
      ].join("\n");

      await message.reply(confirmMsg);

      try {
        const filter    = m => m.author.id === discordUserId && ["1", "2"].includes(m.content.trim());
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ["time"] });
        const choice    = collected.first().content.trim();

        await message.channel.sendTyping();
        await message.channel.send("⏳ กำลัง match Test Case กับ Jira ครับ อาจใช้เวลา 1-2 นาที...");

        const reply = await handleMessage(
          userMessage || "match jira",
          discordUserId,
          excelAttachment.url,
          excelAttachment.name,
          null,
          { systemPrompt, context }
        );
        await sendLong(message, reply);

        // ── เลือก 1 → copy file + save path ──────────────
        if (choice === "1") {
          const fileMatch = reply.match(/__FILE__:(.+)/);
          if (fileMatch) {
            const matchedPath = fileMatch[1].trim();
            const dataDir     = path.join(__dirname, "data");
            const destName    = `matched_${excelAttachment.name}`;
            const destPath    = path.join(dataDir, destName);
            try {
              if (fs.existsSync(matchedPath)) {
                fs.copyFileSync(matchedPath, destPath);
              }
              const result = contextLoader.setExcelPath(discordUserId, currentProject, destPath);
              if (result.ok) {
                await message.channel.send([
                  `✅ บันทึก Excel path สำหรับ project **${currentProject}** แล้วครับ`,
                  `📁 \`${destPath}\``,
                  `ตอนนี้พิมพ์ \`test TC_xxx\` ได้เลยครับ 🚀`,
                ].join("\n"));
              } else {
                await message.channel.send(`⚠️ Match สำเร็จแต่บันทึก path ไม่ได้: ${result.error}`);
              }
            } catch (e) {
              await message.channel.send(`⚠️ Match สำเร็จแต่ copy file ไม่ได้: ${e.message}`);
            }
          }
        } else {
          await message.channel.send("✅ Match เรียบร้อยครับ ไม่ได้บันทึก path ไว้ใช้ต่อ");
        }

      } catch (err) {
        if (err.message?.includes("time") || err.size === 0) {
          await message.channel.send("⏰ หมดเวลา 30 วินาที ยกเลิกครับ");
        } else {
          console.error("Excel confirm error:", err);
          await message.channel.send(`❌ เกิดข้อผิดพลาดครับ: ${err.message}`);
        }
      }

    } else {
      // ไม่มี project → match เลย ไม่ถาม
      await message.reply("⏳ กำลัง match Test Case กับ Jira ครับ อาจใช้เวลา 1-2 นาที...");
      try {
        const reply = await handleMessage(
          userMessage || "match jira",
          discordUserId,
          excelAttachment.url,
          excelAttachment.name,
          null,
          { systemPrompt, context }
        );
        await sendLong(message, reply);
      } catch (err) {
        await message.reply(`❌ เกิดข้อผิดพลาดครับ: ${err.message}`).catch(() => {});
      }
    }
    waitingConfirm.delete(discordUserId);
    return;
  }

  // ── ข้อความว่าง → help ────────────────────────────────────
  if (!userMessage) {
    const proj = context.activeProject?.key || "ยังไม่ได้เลือก";
    await message.reply([
      `สวัสดีครับ **${context.user?.name || "ทีม QA"}** 👋`,
      `Project ปัจจุบัน: **${proj}**`,
      "",
      "**Testing**",
      "`test TC_xxx` — รัน Playwright test",
      "`retest TC_xxx` — retest + update Defect card",
      "`clear cache TC_xxx` — ลบ script cache",
      "",
      "**Project**",
      "`สลับไป project XX` — เปลี่ยน active project",
      "`project ทั้งหมด` — ดู project ที่มี",
      "",
      "**Jira**",
      "`มีงานอะไรบ้าง` — ดู tasks",
      "`งานค้าง` — ดู overdue",
      "`jira on / jira off` — เปิด/ปิด Jira update",
      "",
      "**เลขาส่วนตัว**",
      "`สรุปวันนี้` — สรุปสิ่งที่ทำไป",
      "`วันนี้มีอะไร` — งานที่รออยู่",
      "หรือถามอะไรก็ได้เลยครับ 🙂",
      "",
      "หรือ **แนบ Excel** เพื่อ match Jira link 📎",
    ].join("\n"));
    return;
  }

  // ── handle intent ──────────────────────────────────────────
  if (["1", "2"].includes(userMessage) && !waitingConfirm.has(discordUserId)) {
    console.log(`[SKIP] '${userMessage}' from ${discordUserId} not in waitingConfirm`);
    return;
  }
  if (waitingConfirm.has(discordUserId)) return;

  await message.channel.sendTyping();

  const sendProgress = async (text) => {
    try { await message.channel.send({ content: text }); } catch {}
  };

  try {
    switch (intent) {

      case "switch_project": {
        if (!projectName) {
          const list = (context.allProjects || [])
            .map(p => `• **${p.key}** — Jira: ${p.jiraKey}, Epic: ${p.epicId}`)
            .join("\n") || "ยังไม่มี project ครับ";
          await message.reply(`มี project ดังนี้ครับ:\n${list}\n\nพิมพ์ \`สลับไป project XX\` ได้เลย`);
          break;
        }
        const result = contextLoader.switchProject(discordUserId, projectName);
        if (!result.ok) {
          await message.reply(`ไม่เจอ project **${projectName}** ครับ\nมีแค่: ${(context.allProjects || []).map(p => p.key).join(", ")}`);
        } else {
          await message.reply(`✅ สลับไป project **${projectName}** แล้วครับ พร้อมทำงานเลย`);
          contextLoader.logAction(discordUserId, "switch_project", { project: projectName });
        }
        break;
      }

      case "list_projects": {
        const list = (context.allProjects || [])
          .map(p => `• **${p.key}** — Jira: ${p.jiraKey}, Epic: ${p.epicId}`)
          .join("\n") || "ยังไม่มี project ครับ";
        await message.reply(`Projects ทั้งหมดครับ:\n${list}`);
        break;
      }

      case "jira_toggle": {
        const onOff  = /jira\s+on/i.test(userMessage);
        const result = contextLoader.toggleJira(discordUserId, onOff);
        if (!result.ok) {
          await message.reply(`ไม่สำเร็จครับ: ${result.error}`);
        } else {
          await message.reply(`✅ Jira update สำหรับ project **${result.project}** ${onOff ? "เปิด" : "ปิด"} แล้วครับ`);
        }
        break;
      }

      case "clear_cache": {
        const cacheDir = path.join(__dirname, "test-cache");
        const tcTarget = contextLoader.extractTcId(userMessage);
        if (tcTarget) {
          const file = path.join(cacheDir, tcTarget.replace(/[^a-zA-Z0-9]/g, "_") + ".js");
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            await message.reply(`🗑️ ลบ cache ของ ${tcTarget} แล้วครับ`);
          } else {
            await message.reply(`ไม่พบ cache ของ ${tcTarget} ครับ`);
          }
        } else {
          const files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".js"));
          files.forEach(f => fs.unlinkSync(path.join(cacheDir, f)));
          await message.reply(`🗑️ ลบ cache ทั้งหมด ${files.length} script แล้วครับ`);
        }
        break;
      }

      case "remind": {
        const parsed = parseReminder(userMessage);
        if (!parsed) {
          await message.reply([
            "ขอรูปแบบใหม่อีกทีครับ ลองแบบนี้ครับ:",
            "• `เตือนฉัน ประชุม พรุ่งนี้ 10 โมง`",
            "• `เตือนฉัน ส่งงาน วันนี้ 14:00`",
            "• `เตือนฉัน demo มะรืน 2 ทุ่ม`",
          ].join("\n"));
          break;
        }

        contextLoader.addReminder(discordUserId, parsed.text, parsed.dueAt);
        contextLoader.logAction(discordUserId, "remind", { note: parsed.text });

        const dueLocal = new Date(parsed.dueAt).toLocaleString("th-TH", {
          timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short",
        });
        await message.reply(`⏰ ตั้งเตือนแล้วครับ: **${parsed.text}**\n📅 ${dueLocal}`);
        break;
      }

      case "daily_summary": {
        const sumReply = await handleSummary(discordUserId, context);
        await sendLong(message, sumReply);
        break;
      }

      case "what_today": {
        const sumReply = await handleSummary(discordUserId, context, { mode: "detailed" });
        await sendLong(message, sumReply);
        break;
      }

      default: {
        if (intent === "browser_test" && tcId && !/^\s*retest\b/i.test(userMessage)) {
          const excelPath = getExcelPath(context) || findLatestExcel();
          const prevStatus = excelPath ? getTcStatusFromExcel(excelPath, tcId) : null;
          if (prevStatus && /pass/i.test(prevStatus)) {
            await message.reply(`${tcId} ผ่านแล้วครับ จะให้ Retest ไหมครับ? (yes/no)`);
            waitingConfirm.add(discordUserId);
            try {
              const filter    = m => m.author.id === discordUserId && /^(y|yes|ใช่|n|no|ไม่)/i.test(m.content.trim());
              const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ["time"] });
              const answer    = collected.first().content.trim();
              if (!/^(y|yes|ใช่)/i.test(answer)) {
                await message.channel.send("รับทราบครับ ไม่ retest");
                waitingConfirm.delete(discordUserId);
                break;
              }
            } catch (e) {
              await message.channel.send("หมดเวลา 30 วินาที ยกเลิก retest");
              waitingConfirm.delete(discordUserId);
              break;
            }
            waitingConfirm.delete(discordUserId);
          }
        }

        const reply = await handleMessage(
          userMessage,
          discordUserId,
          null,
          null,
          sendProgress,
          { systemPrompt, context }
        );

        const retestMatch = reply.match(/__ASK_RETEST__:(TC_[A-Z0-9_]+)/);
        const cleanReply  = retestMatch
          ? reply.replace(/\n?__ASK_RETEST__:[^\n]+/, "").trimEnd()
          : reply;

        await sendLong(message, cleanReply);

        const logExtras = {};
        if (tcId)        logExtras.tc      = tcId;
        if (projectName) logExtras.project = projectName;
        if (intent !== "unknown") logExtras.note = userMessage.slice(0, 80);
        contextLoader.logAction(discordUserId, intent, logExtras);

        if (retestMatch) {
          const retestTc = retestMatch[1];
          await message.channel.send(`อัปเดตเรียบร้อยครับ จะให้ Retest ${retestTc} เลยไหมครับ? (yes/no)`);
          waitingConfirm.add(discordUserId);
          try {
            const filter    = m => m.author.id === discordUserId && /^(y|yes|n|no|ใช่|ไม่)\s*$/i.test(m.content.trim());
            const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ["time"] });
            const answer    = collected.first().content.trim();
            waitingConfirm.delete(discordUserId);
            if (/^(y|yes|ใช่)/i.test(answer)) {
              await message.channel.sendTyping();
              await message.channel.send(`⏳ กำลัง retest ${retestTc} ครับ...`);
              const retestReply = await handleMessage(
                `retest ${retestTc}`,
                discordUserId,
                null,
                null,
                sendProgress,
                { systemPrompt, context }
              );
              await sendLong(message, retestReply);
            } else {
              await message.channel.send("✅ รับทราบครับ ไม่ retest");
            }
          } catch (err) {
            waitingConfirm.delete(discordUserId);
            if (err.message?.includes("time") || err.size === 0) {
              await message.channel.send("⏰ หมดเวลา 30 วินาที ยกเลิก retest ครับ");
            } else {
              console.error("Retest prompt error:", err);
              await message.channel.send(`❌ เกิดข้อผิดพลาดครับ: ${err.message}`);
            }
          }
        } else if (
          intent === "browser_test" &&
          tcId &&
          !/^\s*retest\b/i.test(userMessage)
        ) {
          const passMatch = reply.match(/Pass:\s*(\d+)/);
          if (passMatch && parseInt(passMatch[1], 10) > 0) {
            await message.channel.send(`จะให้ Retest เลยไหมครับ? (yes/no)`);
            waitingConfirm.add(discordUserId);
            try {
              const filter    = m => m.author.id === discordUserId && /^(y|yes|n|no|ใช่|ไม่)\s*$/i.test(m.content.trim());
              const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ["time"] });
              const answer    = collected.first().content.trim();
              waitingConfirm.delete(discordUserId);
              if (/^(y|yes|ใช่)/i.test(answer)) {
                await message.channel.sendTyping();
                await message.channel.send(`⏳ กำลัง retest ${tcId} ครับ...`);
                const retestReply = await handleMessage(
                  `retest ${tcId}`,
                  discordUserId,
                  null,
                  null,
                  sendProgress,
                  { systemPrompt, context }
                );
                await sendLong(message, retestReply);
              } else {
                await message.channel.send("✅ รับทราบครับ ไม่ retest");
              }
            } catch (err) {
              waitingConfirm.delete(discordUserId);
              if (err.message?.includes("time") || err.size === 0) {
                await message.channel.send("⏰ หมดเวลา 30 วินาที ยกเลิก retest ครับ");
              } else {
                console.error("Browser PASS retest prompt error:", err);
                await message.channel.send(`❌ เกิดข้อผิดพลาดครับ: ${err.message}`);
              }
            }
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error("Error:", err);
    await message.reply(`❌ เกิดข้อผิดพลาดครับ: ${err.message}`).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
