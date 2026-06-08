// ============================================================
// claude-agent.js — v2 (multi-project + personal assistant)
// ============================================================
require("dotenv").config();

const { spawn }    = require("child_process");
const { execSync } = require("child_process");
const path         = require("path");
const fs           = require("fs");
const https        = require("https");
const http         = require("http");
const os           = require("os");

const JIRA_HOST    = process.env.JIRA_URL;
const JIRA_EMAIL   = process.env.JIRA_EMAIL;
const JIRA_TOKEN   = process.env.JIRA_TOKEN;
const APP_URL      = process.env.APP_URL;
const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;

let jiraUpdateEnabled = process.env.JIRA_UPDATE === "true";
console.log(`Jira update (default): ${jiraUpdateEnabled ? "ON" : "OFF"}`);

const MY_JIRA_ACCOUNT_ID_DEFAULT = "712020:0d2b1187-45f8-41a8-b263-2e1da40067aa";

const CACHE_DIR = path.join(__dirname, "test-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const PLAYWRIGHT_BROWSERS = path.join(
  process.env.LOCALAPPDATA || "C:\\Users\\admin\\AppData\\Local",
  "ms-playwright"
);

function findPython() {
  for (const cmd of ["python", "python3", "py"]) {
    try { execSync(`${cmd} --version`, { stdio: "ignore" }); return cmd; }
    catch {}
  }
  throw new Error("ไม่พบ Python กรุณาติดตั้งที่ https://python.org");
}
const PYTHON = findPython();
console.log("ใช้ Python:", PYTHON);

const TRANSITION = {
  "pass":     { id: "10", label: "? (QA) TESTING DONE" },
  "ผ่าน":    { id: "10", label: "? (QA) TESTING DONE" },
  "done":     { id: "10", label: "? (QA) TESTING DONE" },
  "fail":     { id: "12", label: "? TEST FAILED" },
  "ไม่ผ่าน": { id: "12", label: "? TEST FAILED" },
  "failed":   { id: "12", label: "? TEST FAILED" },
  "block":    { id: "14", label: "?? TEST BLOCKED" },
  "blocked":  { id: "14", label: "?? TEST BLOCKED" },
  "บล็อค":   { id: "14", label: "?? TEST BLOCKED" },
  "retest":   { id: "8",  label: "?? TO TEST (Retest)" },
  "uat":      { id: "5",  label: "?? UAT PENDING" },
  "testing":  { id: "9",  label: "?? TESTING" },
  "fix":      { id: "6",  label: "?? FIXING" },
  "fixing":   { id: "6",  label: "?? FIXING" },
};

function getProjectKey(ctx)  { return ctx?.activeProject?.key      || "SR"; }
function getJiraKey(ctx)     { return ctx?.activeProject?.jiraKey  || "SR"; }
function getEpicId(ctx)      { return ctx?.activeProject?.epicId   || null; }
function getAppUrl(ctx)      { return ctx?.activeProject?.appUrl   || APP_URL; }
function getJiraOn(ctx)      { return ctx?.activeProject?.jiraOn   ?? jiraUpdateEnabled; }
function getMyAccountId(ctx) { return ctx?.user?.jiraAccountId     || MY_JIRA_ACCOUNT_ID_DEFAULT; }
function getExcelPath(ctx)   { return ctx?.activeProject?.excelPath || null; }

function jiraRequest(jql, fields = ["summary","status","assignee","priority","duedate"], startAt = 0, maxResults = 100) {
  return new Promise((resolve, reject) => {
    const auth   = Buffer.from(JIRA_EMAIL + ":" + JIRA_TOKEN).toString("base64");
    const url    = new URL(JIRA_HOST);
    const params = new URLSearchParams({ jql, startAt, maxResults, fields: fields.join(",") });
    const req = https.request({
      hostname: url.hostname,
      path: `/rest/api/3/search/jql?${params.toString()}`,
      method: "GET",
      headers: { Authorization: "Basic " + auth, Accept: "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Jira parse error: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function jiraRequestAll(jql, fields = ["summary","status","assignee","priority","duedate"], maxTotal = 500) {
  let allIssues = [], startAt = 0;
  const pageSize = 100;
  while (true) {
    const data   = await jiraRequest(jql, fields, startAt, pageSize);
    const issues = data.issues || [];
    if (issues.length === 0) break;
    allIssues = allIssues.concat(issues);
    console.log(`Fetched ${allIssues.length} issues`);
    if (allIssues.length >= maxTotal || issues.length < pageSize) break;
    startAt += pageSize;
  }
  console.log(`Total fetched: ${allIssues.length} issues`);
  return allIssues;
}

function jiraPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(JIRA_EMAIL + ":" + JIRA_TOKEN).toString("base64");
    const url     = new URL(JIRA_HOST);
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: apiPath,
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(data ? JSON.parse(data) : { status: res.statusCode }); }
        catch (e) { resolve({ status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function jiraGet(apiPath) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(JIRA_EMAIL + ":" + JIRA_TOKEN).toString("base64");
    const url  = new URL(JIRA_HOST);
    const req  = https.request({
      hostname: url.hostname,
      path: apiPath,
      method: "GET",
      headers: { Authorization: "Basic " + auth, Accept: "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Jira parse error: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function jiraUploadAttachment(issueKey, filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) { resolve(null); return; }
    const auth        = Buffer.from(JIRA_EMAIL + ":" + JIRA_TOKEN).toString("base64");
    const url         = new URL(JIRA_HOST);
    const fileContent = fs.readFileSync(filePath);
    const fileName    = path.basename(filePath);
    const boundary    = "----QABoundary" + Date.now().toString(16);
    const CRLF        = "\r\n";
    const bodyParts   = Buffer.concat([
      Buffer.from("--" + boundary + CRLF + "Content-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"" + CRLF + "Content-Type: image/png" + CRLF + CRLF),
      fileContent,
      Buffer.from(CRLF + "--" + boundary + "--" + CRLF),
    ]);
    const req = https.request({
      hostname: url.hostname,
      path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": bodyParts.length,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.write(bodyParts);
    req.end();
  });
}

async function createDefectCard(tcId, summary, steps, expected, actual, jiraKey, ctx) {
  console.log("[createDefectCard] jiraKey:", jiraKey);
  const projectKey = getJiraKey(ctx);
  const issueKey   = jiraKey.split("/").pop();
  const now        = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });

  let epicKey = getEpicId(ctx) || null;
  if (!epicKey) {
    try {
      const issueData = await jiraGet(`/rest/api/3/issue/${issueKey}?fields=parent`);
      epicKey = issueData.fields?.parent?.key ?? null;
      if (epicKey) console.log(`[createDefectCard] Epic key (from Jira): ${epicKey}`);
    } catch (e) {
      console.error("[createDefectCard] ดึง parent ล้มเหลว:", e.message);
    }
  } else {
    console.log(`[createDefectCard] Epic key (from context): ${epicKey}`);
  }

  const rachataAccountId = await searchJiraUser("Rachata");
  if (rachataAccountId) console.log(`[createDefectCard] Rachata accountId: ${rachataAccountId}`);

  const descText = [
    `🐛 Defect พบจากการทดสอบ Test Case: ${tcId}`,
    `📋 Test Case Summary: ${summary}`,
    `🔗 Jira Link: ${JIRA_HOST}/browse/${jiraKey}`,
    `📝 Test Steps:\n${steps}`,
    `✅ Expected Result:\n${expected}`,
    `❌ Actual Result:\n${actual}`,
    `🤖 สร้างอัตโนมัติโดย QA Bot เมื่อ ${now}`,
  ].join("\n\n");

  const fields = {
    project:     { key: projectKey },
    summary:     `[DEFECT] ${tcId} — ${summary.slice(0, 100)}`,
    description: {
      type: "doc", version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: descText }] }],
    },
    issuetype: { id: "11274" },
    priority:  { name: "Medium" },
  };

  if (rachataAccountId) fields.assignee = { accountId: rachataAccountId };
  if (epicKey)          fields.parent   = { key: epicKey };

  const response = await jiraPost("/rest/api/3/issue", { fields });
  console.log("[createDefectCard] response:", JSON.stringify(response));
  return response;
}

async function searchJiraUser(name) {
  return new Promise((resolve) => {
    const auth = Buffer.from(JIRA_EMAIL + ":" + JIRA_TOKEN).toString("base64");
    const url  = new URL(JIRA_HOST);
    const req  = https.request({
      hostname: url.hostname,
      path: `/rest/api/3/user/search?query=${encodeURIComponent(name)}`,
      method: "GET",
      headers: { Authorization: "Basic " + auth, Accept: "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)[0]?.accountId ?? null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function findClaudeExe() {
  const base     = path.join(process.env.LOCALAPPDATA, "Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code");
  const versions = fs.readdirSync(base).sort().reverse();
  for (const ver of versions) {
    const p = path.join(base, ver, "claude.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("ไม่พบ claude.exe");
}

const claudeExe = findClaudeExe();
console.log("ใช้ claude.exe:", claudeExe);

function askClaude(prompt, systemPrompt = null) {
  return new Promise((resolve, reject) => {
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n=== คำถาม/ข้อความ ===\n${prompt}`
      : prompt;
    const proc = spawn(claudeExe, ["-p", fullPrompt, "--dangerously-skip-permissions"], {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `Exit code ${code}`));
      resolve(stdout.trim());
    });
    proc.on("error", reject);
    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

function getCacheKey(tc)  { return tc.tc_id.replace(/[^a-zA-Z0-9]/g, "_"); }
function getCachePath(tc) { return path.join(CACHE_DIR, `${getCacheKey(tc)}.js`); }

function loadCachedScript(tc) {
  const cachePath = getCachePath(tc);

  // ตรวจ exact cache path
  if (fs.existsSync(cachePath)) {
    console.log(`[CACHE HIT] ${tc.tc_id}`);
    return fs.readFileSync(cachePath, "utf8");
  }

  // ถ้าไม่เจอ exact path — scan test-cache หาตัวที่ match tc_id
  try {
    const cacheKey = getCacheKey(tc);
    const rawKey   = tc.tc_id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const files    = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".js"));
    const match    = files.find(f => {
      const base = f.replace(/\.js$/, "");
      return base === cacheKey || base === rawKey;
    });
    if (match) {
      const foundPath = path.join(CACHE_DIR, match);
      console.log(`[CACHE HIT] ${tc.tc_id} (found in test-cache: ${match})`);
      return fs.readFileSync(foundPath, "utf8");
    }
  } catch (_) { /* ignore scan error */ }

  console.log(`[CACHE MISS] ${tc.tc_id} — ไม่พบใน test-cache จะ generate ใหม่`);
  return null;
}

function saveScriptToCache(tc, script) {
  fs.writeFileSync(getCachePath(tc), script, "utf8");
  console.log(`[CACHE SAVED] ${tc.tc_id}`);
}

function clearCache(tcId = null) {
  if (tcId) {
    const file = path.join(CACHE_DIR, `${tcId.replace(/[^a-zA-Z0-9]/g, "_")}.js`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return `✅ ลบ cache ของ ${tcId} แล้วครับ`; }
    return `ไม่พบ cache ของ ${tcId} ครับ`;
  }
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".js"));
  files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
  return `✅ ลบ cache ทั้งหมด ${files.length} script แล้วครับ`;
}

// ══ PLAYWRIGHT PROMPT BUILDER ═══════════════════════════════
function buildPlaywrightPrompt(tc, appUrl) {
  return `คุณคือ QA Automation Engineer ที่เชี่ยวชาญ Playwright

รายละเอียด Test Case:
TC ID: ${tc.tc_id}
Summary: ${tc.summary}
Test Steps:
${tc.steps}
Expected Result:
${tc.expected}

System URL: ${appUrl}
Username: ${APP_USERNAME}
Password: ${APP_PASSWORD}
Node modules path: ${path.join(__dirname, "node_modules")}

เขียน Playwright script (Node.js) สำหรับทดสอบ TC นี้
ข้อกำหนด:
1. บรรทัดแรกสุดของโค้ด: const { chromium } = require('${path.join(__dirname, "node_modules", "playwright").replace(/\\/g, "\\\\")}');
2. อย่าใช้ @playwright/test หรือ playwright ให้ใช้ตรงๆแทน
3. ใช้ headless: true และ executablePath: 'C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium-1208\\\\chrome-win64\\\\chrome.exe' เท่านั้น
4. setDefaultTimeout(15000)
5. ก่อน process.exit ทั้ง PASS และ FAIL ให้ถ่าย screenshot ก่อน:
   try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_se) {}
   - PASS: screenshot แล้ว process.exit(0)
   - FAIL: console.error("FAIL: เหตุผล")  screenshot แล้ว process.exit(1)
6. ตอบเฉพาะ JavaScript code เท่านั้น ห้าม markdown
7. ใช้ selector ทุกกรณี ให้ใช้ getByPlaceholder, getByText, getByRole, getByLabel แทน encoding ที่อาจเปลี่ยนได้ ไม่ใช้ CSS selector เท่านั้น

ข้อมูล UI จริงของระบบ (ต้องอ่านและทำตามนี้):

LOGIN (ใช้ keyboard.type แทน fill เสมอ เพื่อให้ React state อัปเดต):
- await page.goto('${appUrl}');
- await page.waitForSelector('input', { timeout: 10000 });
- await page.waitForTimeout(1000);
- await page.locator('input').first().click();
- await page.locator('input').first().clear();
- await page.keyboard.type('${APP_USERNAME}', { delay: 50 });
- await page.waitForTimeout(300);
- await page.locator('input[type=password]').click();
- await page.keyboard.type('${APP_PASSWORD}', { delay: 50 });
- await page.waitForTimeout(300);
- await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => {
      const t = (b.textContent || '').trim();
      return t === 'Sign In' || t === 'เข้าสู่ระบบ' || t === 'Login';
    });
    if (btn) btn.click();
  });
- await page.waitForLoadState('networkidle');
- await page.waitForTimeout(2000);
- หลัง login เช็ค popup session ซ้อน (รองรับทั้งภาษาไทย 'ยืนยัน' และอังกฤษ 'Confirm' / 'Confirm Sign In'):
  try {
    const allBtns = await page.locator('button').all();
    for (const btn of allBtns) {
      const text = await btn.textContent();
      if (text && (text.includes('ยืนยัน') || text.includes('Confirm Sign In') || text.includes('Confirm'))) {
        await btn.click();
        break;
      }
    }
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  } catch (e) {}

LOGOUT (do before every process.exit):
- try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch(_) {}
- This clears the session so the next run will not show the duplicate-session popup.

NAVIGATION (ใช้ goto URL โดยตรง อย่าคลิก sidebar):
- จัดการผู้ใช้งาน (User Management):
  await page.goto('${appUrl}'.replace(/\\/$/, '') + '/user-management');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
- คลิก tab Roles (ใช้ evaluate เสมอ ห้ามใช้ filter hasText ภาษาไทย):
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => (b.textContent || '').trim() === 'Roles');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);
- คลิก tab Groups (ใช้ evaluate เสมอ):
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => (b.textContent || '').trim() === 'Groups');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);
- ปิด overlay/modal ก่อนคลิก tab:
  await page.waitForSelector('div[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});

ADD ROLE MODAL:
- เปิด modal:
  await page.locator('button').filter({ hasText: /เพิ่ม Role/ }).click();
  await page.waitForSelector('div[role="dialog"]', { state: 'visible' });
  await page.waitForTimeout(500);
- กรอกชื่อ Role (ไทย) ผ่าน id ตรง:
  await page.locator('#input-\\u0e0a\\u0e37\\u0e48\\u0e2d-role-\\(\\u0e44\\u0e17\\u0e22\\)').click();
  await page.keyboard.type('ชื่อ Role ที่ต้องการ', { delay: 50 });
  หรือใช้ evaluate แทน:
  await page.evaluate((val) => {
    const el = document.getElementById('input-ชื่อ-role-(ไทย)');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'ค่าที่ต้องการ');
- กรอกชื่อ Role (อังกฤษ) ผ่าน evaluate เช่น:
  await page.evaluate((val) => {
    const el = document.getElementById('input-ชื่อ-role-(อังกฤษ)');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'ค่าที่ต้องการ');
- Status toggle: ON by default หาก ไม่ต้องการ (aria-pressed="true")
- Checkbox permissions (เฉพาะใน modal, index เริ่มจาก 0):
  nth(0) = แดชบอร์ด
  nth(1) = นำเข้าข้อมูล   Import
  nth(2) = ปรับปรุงข้อมูล     Adjust RDT
  nth(3) = สร้างข้อมูลนิติบุคคล
  nth(4) = ปรับปรุงข้อมูลนิติบุคคลผ่านฟอร์ม
  nth(5) = ปรับปรุงข้อมูลนิติบุคคลผ่าน Excel
  วิธีคลิก (ใช้ evaluate เพราะอาจ checkbox อยู่ใน scrollable container):
  await page.evaluate((idx) => {
    const boxes = document.querySelectorAll('div[role="dialog"] input[type="checkbox"]');
    if (boxes[idx]) boxes[idx].click();
  }, 1); // เปลี่ยน index ตาม permission ที่ต้องการ
- บันทึก (ปุ่ม เพิ่ม Role ใน modal):
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('div[role="dialog"] button')];
    const btn = btns.find(b => b.textContent.trim() === 'เพิ่ม Role' && !b.disabled);
    if (btn) btn.click();
  });
  await page.waitForSelector('div[role="dialog"]', { state: 'detached', timeout: 10000 });

ADD GROUP MODAL:
- เปิด modal:
  await page.locator('button').filter({ hasText: /เพิ่ม Group/ }).click();
  await page.waitForSelector('div[role="dialog"]', { state: 'visible' });
  await page.waitForTimeout(500);
- กรอกชื่อ Group ผ่าน evaluate:
  await page.evaluate((val) => {
    const inputs = document.querySelectorAll('div[role="dialog"] input[type="text"]');
    if (inputs[0]) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[0], val);
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, 'ชื่อ Group');
- Assign Role ใน Group modal (dropdown หรือ checkbox):
  await page.evaluate((idx) => {
    const boxes = document.querySelectorAll('div[role="dialog"] input[type="checkbox"]');
    if (boxes[idx]) boxes[idx].click();
  }, 0);
- บันทึก Group:
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('div[role="dialog"] button')];
    const btn = btns.find(b => b.textContent.trim() === 'เพิ่ม Group' && !b.disabled);
    if (btn) btn.click();
  });
  await page.waitForSelector('div[role="dialog"]', { state: 'detached', timeout: 10000 });

BUTTON CLICK (ข้างนอก modal):
- await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.trim() === 'ยกเลิก');
    if (btn) btn.click();
  });

SWEETALERT2 POPUP (จะปรากฏหลังสร้าง Role, Group หรือทุก action ที่มี popup ตามมา):
- กด ยืนยัน: await page.locator('button.swal2-confirm').click().catch(() => {});
- รอ popup ปิด: await page.waitForTimeout(1000);
- อย่าใช้ waitForSelector div[role="dialog"] state detached เพราะ SweetAlert2 ใช้ class swal2-popup ไม่มี role=dialog
- ใช้ await page.waitForTimeout(2000) แทนการรอ dialog detached เสมอ
- อย่าใช้ getByRole button name เพราะไม่เจอ ใช้ button.swal2-confirm เท่านั้น

MAPPING คำแปล:
- Import = นำเข้าข้อมูล
- Adjust RDT = ปรับปรุงข้อมูล
- User Management = จัดการผู้ใช้งาน


8. เขียน script แบบ 6 section พร้อม comment กำกับ:
   // ── 1. เปิด Browser ──────────────────────────────────────────
   // ── 2. เปิดหน้าเว็บ ──────────────────────────────────────────
   // ── 3. Login เข้าระบบ ────────────────────────────────────────
   // ── 4. ขั้นตอนการทดสอบ ───────────────────────────────────────
   //        (เขียนส่วนนี้ตาม flow ของ TC ที่เขียน)
   // ── 5. ตรวจสอบผลลัพธ์ (Assertion) ───────────────────────────
   //        (เขียนส่วนนี้ตาม expected result ที่เขียน)
   // ── 6. ปิด Browser ───────────────────────────────────────────

9. บรรทัดแรกสุด (ก่อน require) ให้ใส่ header comment:
   // ============================================================
   // ${tc.tc_id} — ${tc.summary}
   // Module: ${tc.module ?? ''}
   // *** section 4 = ขั้นตอนทดสอบ | section 5 = เงื่อนไข assert
   // ============================================================

10. ต่อจากนั้น วางบรรทัดบนสุดหลัง require ก่อน section 1:
    const USERNAME = '${APP_USERNAME}'; //  แก้ตรงนี้ถ้า user เปลี่ยน
    const PASSWORD = '${APP_PASSWORD}'; //  แก้ตรงนี้ถ้า password เปลี่ยน

11. ทุก action ใน section 4 ต้องมี comment อธิบาย 1 บรรทัดกำกับ
    เช่น // คลิกปุ่มเพิ่ม Role ใหม่
         // รอ modal เปิด
         // กรอกชื่อ Role ภาษาไทย

สำคัญเกี่ยวกับการ execute script:
- ห้ามรัน node เพื่อ execute script เอง ทำแค่นี้
- ห้าม save เพิ่มเติมอะไรเอง อย่าส่งงานเพิ่มเติมไปบ้าง
- การทดสอบจริงทำผ่าน Discord bot เท่านั้น
`;
}

async function handleBrowserTest(tcList, sendProgress, excelPath, ctx) {
  const results   = [];
  const defects   = [];
  const scriptDir = os.tmpdir();

  const appUrl     = getAppUrl(ctx);
  const jiraOn     = getJiraOn(ctx);
  const projectKey = getJiraKey(ctx);

  for (let i = 0; i < tcList.length; i++) {
    const tc = tcList[i];
    await sendProgress(`${tc.retest ? "🔄 Retest" : "🔍 กำลังทดสอบ"} ${tc.tc_id} (${i+1}/${tcList.length})...`);

    let script = loadCachedScript(tc);

    if (!script) {
      // ตรวจสอบว่ามีอยู่ใน test-cache ก่อน generate ใหม่
      const testCachePath = getCachePath(tc);
      if (fs.existsSync(testCachePath)) {
        console.log(`[TEST-CACHE] โหลด ${tc.tc_id} จาก test-cache — ข้ามการ generate ใหม่`);
        script = fs.readFileSync(testCachePath, "utf8");
      }
    }

    if (!script) {
      const playwrightPrompt = buildPlaywrightPrompt(tc, appUrl);
      try {
        script = await askClaude(playwrightPrompt);
        script = script
          .replace(/```javascript\n?/g, "")
          .replace(/```js\n?/g, "")
          .replace(/```\n?/g, "");

        const chromiumExe = "C:\\Users\\admin\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe".replace(/\\/g, "\\\\");
        script = `process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '${chromiumExe}';\n` + script;

        saveScriptToCache(tc, script);
      } catch (e) {
        results.push({ tc_id: tc.tc_id, status: "ERROR", actual: `Claude error: ${e.message}` });
        continue;
      }
    }

    const issueKey      = tc.jira_key ? tc.jira_key.split("/").pop() : null;
    const screenshotDir = path.join(SCREENSHOTS_DIR, projectKey, tc.tc_id);
    fs.mkdirSync(screenshotDir, { recursive: true });
    const tsStr      = new Date().toISOString().slice(0, 16).replace("T", "_").replace(/:/g, "-");
    const ssPassPath = path.join(screenshotDir, `pass_${tsStr}.png`).replace(/\\/g, "\\\\");
    const ssFailPath = path.join(screenshotDir, `fail_${tsStr}.png`).replace(/\\/g, "\\\\");
    const ssTmpPath  = path.join(screenshotDir, `_tmp_${tsStr}.png`);
    const runScript  = script
      .replace(/process\.exit\(0\)/g, `try { await page.screenshot({ path: '${ssPassPath}', fullPage: true }); } catch (_se) {}\n  process.exit(0)`)
      .replace(/process\.exit\(1\)/g, `try { await page.screenshot({ path: '${ssFailPath}', fullPage: true }); } catch (_se) {}\n  process.exit(1)`);

    console.log(`[SCREENSHOT PASS] ${ssPassPath}`);
    console.log(`[SCREENSHOT FAIL] ${ssFailPath}`);

    const scriptPath = path.join(scriptDir, `test_${tc.tc_id.replace(/[^a-zA-Z0-9]/g, "_")}.js`);
    fs.writeFileSync(scriptPath, runScript, "utf8");

    let passed = false, failReason = "";
    try {
      execSync(`node "${scriptPath}"`, {
        encoding: "utf8",
        timeout: 120000,
        cwd: __dirname,
        env: {
          ...process.env,
          NODE_PATH: path.join(__dirname, "node_modules"),
          PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS,
          SCREENSHOT_PATH: ssTmpPath,
        },
      });
      passed = true;
    } catch (e) {
      passed     = false;
      failReason = e.stderr || e.stdout || e.message || "Unknown error";
      if (failReason.includes("Executable doesn't exist") || failReason.includes("browserType.launch")) {
        const cachePath = getCachePath(tc);
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        console.log(`[CACHE CLEARED] ${tc.tc_id}`);
      }
    }

    const ssPassFinal = path.join(screenshotDir, `pass_${tsStr}.png`);
    const ssFailFinal = path.join(screenshotDir, `fail_${tsStr}.png`);
    if (fs.existsSync(ssTmpPath)) {
      const renameTo = passed ? ssPassFinal : ssFailFinal;
      fs.renameSync(ssTmpPath, renameTo);
    }
    const screenshotPath = passed
      ? (fs.existsSync(ssPassFinal) ? ssPassFinal : null)
      : (fs.existsSync(ssFailFinal) ? ssFailFinal : null);
    if (screenshotPath) console.log(`[SCREENSHOT] ${screenshotPath}`);

    results.push({
      tc_id:    tc.tc_id,
      status:   passed ? "PASS" : "FAIL",
      jira_key: tc.jira_key,
      actual:   passed ? "ผ่านการทดสอบอัตโนมัติ" : failReason.slice(0, 500),
    });

    const now    = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
    const ssNote = screenshotPath ? `\n📸 Screenshot: ${path.basename(screenshotPath)}` : "";

    if (issueKey && jiraOn) {
      if (passed) {
        try {
          const passDefect = await findLatestDefect(tc.tc_id, projectKey);
          if (passDefect) {
            const defectKey = passDefect.key;
            if (screenshotPath) await jiraUploadAttachment(defectKey, screenshotPath);
            const commentText = screenshotPath
              ? `✅ PASS: ${tc.tc_id} — ผ่านการทดสอบแล้ว\nทดสอบเมื่อ: ${now}\n📎 ดู screenshot แนบมากับ card นี้`
              : `✅ PASS: ${tc.tc_id} — ผ่านการทดสอบแล้ว\nทดสอบเมื่อ: ${now}`;
            await jiraPost(`/rest/api/3/issue/${defectKey}/comment`, {
              body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: commentText }] }] },
            });
            await jiraPost(`/rest/api/3/issue/${defectKey}/transitions`, { transition: { id: "31" } });
          } else {
            await jiraPost(`/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: "10" } });
            if (screenshotPath) await jiraUploadAttachment(issueKey, screenshotPath);
            await jiraPost(`/rest/api/3/issue/${issueKey}/comment`, {
              body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `✅ ${tc.tc_id} — ผ่านการทดสอบอัตโนมัติ\nทดสอบเมื่อ: ${now}${ssNote}` }] }] },
            });
          }
        } catch (e) { console.error("Jira update error:", e.message); }
      } else {
        try {
          const existing = await findExistingDefect(tc.tc_id, projectKey);
          let defectKey;
          if (existing) {
            defectKey = existing.key;
            if (screenshotPath) await jiraUploadAttachment(defectKey, screenshotPath);
            await jiraPost(`/rest/api/3/issue/${defectKey}/comment`, {
              body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `🔄 Retest FAIL: ${tc.tc_id}\nเหตุผล: ${failReason.slice(0, 300)}\nทดสอบเมื่อ: ${now}${ssNote}` }] }] },
            });
          } else if (!tc.retest) {
            const defect = await createDefectCard(tc.tc_id, tc.summary, tc.steps, tc.expected, failReason.slice(0, 500), tc.jira_key, ctx);
            defectKey = defect.key;
            if (defectKey && screenshotPath) await jiraUploadAttachment(defectKey, screenshotPath);
          } else {
            console.log(`[RETEST] FAIL ไม่พบ Defect card สำหรับ ${tc.tc_id}`);
          }
          if (defectKey) {
            defects.push({ tc_id: tc.tc_id, defect_key: defectKey });
            const defectNote = screenshotPath ? `\n📎 Screenshot: ${path.basename(screenshotPath)} (แนบที่ ${defectKey})` : "";
            await jiraPost(`/rest/api/3/issue/${issueKey}/comment`, {
              body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `❌ ${tc.tc_id} — ไม่ผ่านการทดสอบ\nDefect Card: ${defectKey}${existing ? " (existing)" : " (new)"}\nเหตุผล: ${failReason.slice(0, 300)}\nทดสอบเมื่อ: ${now}${defectNote}` }] }] },
            });
          }
        } catch (e) { console.error("Create/update defect error:", e.message); }
      }
    } else if (!jiraOn) {
      console.log(`[JIRA OFF] ข้าม Jira update สำหรับ ${tc.tc_id}`);
      if (issueKey && screenshotPath) {
        try { await jiraUploadAttachment(issueKey, screenshotPath); }
        catch (e) { console.error("Upload screenshot error:", e.message); }
      }
    }

    try { fs.unlinkSync(scriptPath); } catch {}
  }

  const resolvedExcel = excelPath || getExcelPath(ctx) || findLatestExcel();
  if (resolvedExcel && fs.existsSync(resolvedExcel)) {
    const writeResultScript = path.join(os.tmpdir(), "qa_write_result.py");
    const resultsJson = JSON.stringify(results).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    fs.writeFileSync(writeResultScript, [
      "# -*- coding: utf-8 -*-",
      "import sys, io",
      "sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')",
      "import openpyxl, json, re",
      `wb = openpyxl.load_workbook(r'${resolvedExcel.replace(/\\/g, "\\\\")}')`,
      "ws = wb['Test Case']",
      `results = json.loads('${resultsJson}')`,
      "result_map = {r['tc_id']: r for r in results}",
      "def clean(v): return re.sub(r'[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]', '', str(v or ''))[:500]",
      "header_row = 4",
      "tc_col = actual_col = status_col = None",
      "for cell in ws[header_row]:",
      "    v = str(cell.value or '')",
      "    if 'Test Case' in v and 'ID' in v: tc_col = cell.column",
      "    if 'Actual' in v: actual_col = cell.column",
      "    if 'Scenario' in v and 'Status' in v: status_col = cell.column",
      "for row in ws.iter_rows(min_row=header_row+1):",
      "    tc_id = str(row[tc_col-1].value or '').strip() if tc_col else ''",
      "    if tc_id in result_map:",
      "        r = result_map[tc_id]",
      "        if actual_col: row[actual_col-1].value = clean(r.get('actual', ''))",
      "        if status_col: row[status_col-1].value = 'PASS' if r['status'] == 'PASS' else 'FAIL'",
      `wb.save(r'${resolvedExcel.replace(/\\/g, "\\\\")}')`,
      "print('saved')",
    ].join("\n"), "utf8");
    try {
      execSync(`${PYTHON} "${writeResultScript}"`, {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
      console.log("Written results back to Excel");
    } catch (e) { console.error("Write result error:", e.message); }
  }

  const passCount  = results.filter(r => r.status === "PASS").length;
  const failCount  = results.filter(r => r.status === "FAIL").length;
  const errCount   = results.filter(r => r.status === "ERROR").length;
  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".js"));
  const passLines  = results.filter(r => r.status === "PASS").map(r => `— ✅ ${r.tc_id}${r.jira_key ? `  ${r.jira_key}` : ""}`).join("\n");
  const failLines  = results.filter(r => r.status === "FAIL").map(r => {
    const defect = defects.find(d => d.tc_id === r.tc_id);
    return `— ❌ ${r.tc_id}${defect ? `  Defect: **${defect.defect_key}** (${JIRA_HOST}/browse/${defect.defect_key})` : ""}\n  → ${r.actual?.slice(0, 100) ?? ""}`;
  }).join("\n");
  const errLines = results.filter(r => r.status === "ERROR").map(r => `— ⚠️ ${r.tc_id} — ${r.actual?.slice(0, 100)}`).join("\n");

  const parts = [
    `📊 **ผลการทดสอบ** [${projectKey}] — ${results.length} Test Cases`,
    `✅ Pass: ${passCount} | ❌ Fail: ${failCount} | ⚠️ Error: ${errCount}`,
    `💾 Script cache: ${cacheFiles.length} TC`,
    `📁 Screenshots: ${path.join(SCREENSHOTS_DIR, projectKey)}`,
    `🔄 Jira update: ${jiraOn ? "ON ✅" : "OFF ❌"}`,
  ];
  if (passLines) parts.push(`\n**Pass:**\n${passLines}`);
  if (failLines) parts.push(`\n**Fail:**\n${failLines}`);
  if (errLines)  parts.push(`\n**Error:**\n${errLines}`);
  if (defects.length > 0) parts.push(`\n🐞 **Defect Cards:** ${defects.map(d => d.defect_key).join(", ")}`);
  if (resolvedExcel) parts.push(`\n💾 บันทึกผลลง Excel แล้วครับ\n__FILE__:${resolvedExcel}`);

  return parts.join("\n");
}

function findLatestExcel() {
  const tmpDir  = os.tmpdir();
  const matched = fs.readdirSync(tmpDir).filter(f => f.startsWith("matched_") && f.endsWith(".xlsx")).map(f => ({ name: f, time: fs.statSync(path.join(tmpDir, f)).mtime })).sort((a, b) => b.time - a.time);
  const others  = fs.readdirSync(tmpDir).filter(f => f.endsWith(".xlsx") && !f.startsWith("matched_")).map(f => ({ name: f, time: fs.statSync(path.join(tmpDir, f)).mtime })).sort((a, b) => b.time - a.time);
  const found   = matched.length > 0 ? matched : others;
  return found.length > 0 ? path.join(tmpDir, found[0].name) : null;
}

async function readTestCasesFromExcel(filePath, tcFilter = null) {
  const readScript = path.join(os.tmpdir(), "qa_read_tc.py");
  fs.writeFileSync(readScript, [
    "# -*- coding: utf-8 -*-",
    "import sys, io",
    "sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')",
    "import pandas as pd, json",
    `df = pd.read_excel(r'${filePath.replace(/\\/g, "\\\\")}', sheet_name='Test Case', header=2)`,
    "rows = []",
    "for i, row in df.iterrows():",
    "    tc_id    = str(row.get('Test Case\\nID', '') or '').strip()",
    "    summary  = str(row.get('Summary', '') or '').strip()",
    "    module   = str(row.get('Module /\\nFeature', '') or '').strip()",
    "    steps    = str(row.get('Test Steps', '') or '').strip()",
    "    expected = str(row.get('Expected\\nResult', '') or '').strip()",
    "    upload   = str(row.get('Upload\\nJira', '') or '').strip()",
    "    if tc_id and tc_id.startswith('TC_') and summary and summary != 'nan':",
    "        rows.append({'tc_id': tc_id, 'summary': summary, 'module': module, 'steps': steps, 'expected': expected, 'jira_key': upload if upload not in ['No','nan',''] else None})",
    "print(json.dumps(rows, ensure_ascii=False))",
  ].join("\n"), "utf8");
  const result = execSync(`${PYTHON} "${readScript}"`, {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  let testCases = JSON.parse(result.trim());
  if (tcFilter) testCases = testCases.filter(tc => tc.tc_id.toLowerCase() === tcFilter.toLowerCase());
  return testCases;
}

async function findExistingDefect(tcId, projectKey = "SR") {
  const jql = `project = "${projectKey}" AND summary ~ "[DEFECT] ${tcId}" AND status not in (Done, Closed, Resolved) ORDER BY created DESC`;
  try {
    const data = await jiraRequest(jql, ["summary", "status"], 0, 1);
    return data.issues?.[0] ?? null;
  } catch (e) { console.error("findExistingDefect error:", e.message); return null; }
}

async function findLatestDefect(tcId, projectKey = "SR") {
  const jql = `project = "${projectKey}" AND summary ~ "[DEFECT] ${tcId}" ORDER BY created DESC`;
  try {
    const data = await jiraRequest(jql, ["summary", "status"], 0, 1);
    return data.issues?.[0] ?? null;
  } catch (e) { console.error("findLatestDefect error:", e.message); return null; }
}

function calcOverdueDays(d) {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(d); due.setHours(0, 0, 0, 0);
  return Math.round((today - due) / 86400000);
}

function issueLine(i) {
  const days       = calcOverdueDays(i.fields.duedate);
  const overdueTxt = days !== null ? ` (เกิน ${days} วัน)` : "";
  return `— **${i.key}** ${i.fields.summary}\n` +
    `  — Status: \`${i.fields.status?.name ?? "?"}\`` +
    ` | Priority: ${i.fields.priority?.name ?? "N/A"}` +
    ` | Assignee: ${i.fields.assignee?.displayName ?? "ไม่มี assignee"}` +
    ` | Due: ${i.fields.duedate ?? "ไม่กำหนด"}${overdueTxt}`;
}

async function handleUpdateIssue(issueKey, action, comment) {
  const transition = TRANSITION[action];
  if (!transition) return `❌ ไม่รู้จัก action: ${action}`;
  const now         = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  const commentText = comment
    ? `${comment}\n\n_อัพเดทโดย QA Bot เมื่อ ${now}_`
    : `เปลี่ยน status เป็น ${transition.label}\n\n_อัพเดทโดย QA Bot เมื่อ ${now}_`;
  try {
    await jiraPost(`/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: transition.id } });
    await jiraPost(`/rest/api/3/issue/${issueKey}/comment`, {
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: commentText }] }] },
    });
    return `${transition.label}\n**${issueKey}** อัพเดทเรียบร้อยครับ\n💬 Comment: ${commentText}`;
  } catch (err) {
    return `❌ ไม่สามารถอัพเดท ${issueKey}: ${err.message}`;
  }
}

async function handleOverdue(ctx) {
  const accountId = getMyAccountId(ctx);
  let jql  = `duedate < startOfDay() AND status not in (Done, Closed, Resolved) AND assignee = "${accountId}" ORDER BY duedate ASC`;
  let data = await jiraRequest(jql, ["summary","status","assignee","priority","duedate"]);
  if (data.errorMessages?.length)
    data = await jiraRequest(jql.replace("startOfDay()", "now()"), ["summary","status","assignee","priority","duedate"]);
  const issues = data.issues || [];
  if (issues.length === 0) return "✅ ไม่พบ issue ของคุณเกิน due date ครับ";
  const more = issues.length > 25 ? `\n\n...มีอีก ${issues.length - 25} issue` : "";
  return `⚠️ **Issue ของคุณเกิน Due Date** — มี ${issues.length} issue\n\n` +
    issues.slice(0, 25).map(issueLine).join("\n") + more;
}

async function handleUatPending(userMessage, ctx) {
  const accountId    = getMyAccountId(ctx);
  const m            = userMessage.toLowerCase();
  const projectMatch = m.match(/\b(sr|dm2sp0|e1a2ep0|ntb|pt|pj|tmr)\b/i);
  const projectFilter = projectMatch ? ` AND project = "${projectMatch[1].toUpperCase()}"` : "";
  const jql    = `status = "UAT PENDING" AND assignee = "${accountId}"${projectFilter} ORDER BY duedate ASC`;
  const data   = await jiraRequest(jql, ["summary","status","assignee","priority","duedate"]);
  const issues = data.issues || [];
  if (issues.length === 0) return "ไม่พบ issue UAT PENDING ของคุณครับ";
  const overdue = [], onTime = [], noDue = [];
  for (const i of issues) {
    const assignee = i.fields.assignee?.displayName ?? "ไม่มี assignee";
    const duedate  = i.fields.duedate;
    if (!duedate) { noDue.push(`— **${i.key}** ${i.fields.summary} | Assignee: ${assignee}`); }
    else {
      const days = calcOverdueDays(duedate);
      if (days > 0) overdue.push(`— **${i.key}** ${i.fields.summary} | Assignee: ${assignee} | Due: ${duedate} (เกิน ${days} วัน)`);
      else          onTime.push(`— **${i.key}** ${i.fields.summary} | Assignee: ${assignee} | Due: ${duedate} (อีก ${Math.abs(days)} วัน)`);
    }
  }
  let r = `🕐 **UAT PENDING** — ${issues.length} issue\n`;
  if (overdue.length) r += `\n⚠️ **เกิน Due Date (${overdue.length})**\n` + overdue.join("\n");
  if (onTime.length)  r += `\n📅 **ยังไม่เกิน (${onTime.length})**\n`     + onTime.join("\n");
  if (noDue.length)   r += `\n❓ **ไม่กำหนด Due Date (${noDue.length})**\n` + noDue.join("\n");
  return r;
}

async function handleDueSoon(days, ctx) {
  const accountId = getMyAccountId(ctx);
  const jql    = `duedate >= startOfDay() AND duedate <= endOfDay(${days}d) AND status not in (Done, Closed, Resolved) AND assignee = "${accountId}" ORDER BY duedate ASC`;
  const data   = await jiraRequest(jql);
  const issues = data.issues || [];
  if (issues.length === 0) return `✅ ไม่พบ issue ของคุณที่จะถึงกำหนด ${days} วันข้างหน้าครับ`;
  const lines = issues.slice(0, 20).map((i) => {
    const left = Math.abs(calcOverdueDays(i.fields.duedate));
    return `— **${i.key}** ${i.fields.summary}\n  — Due: ${i.fields.duedate ?? "ไม่กำหนด"} (อีก ${left} วัน) | Assignee: ${i.fields.assignee?.displayName ?? "-"}`;
  });
  return `📅 **Due ใน ${days} วัน** — ${issues.length} issue\n\n` + lines.join("\n");
}

async function handleMyTasks(userMessage, ctx, systemPrompt) {
  const accountId = getMyAccountId(ctx);
  const m         = userMessage.toLowerCase();
  const cond      = [`assignee = "${accountId}"`];
  if (m.includes("to test") || m.includes("ทดสอบ"))       cond.push(`status = "TO TEST"`);
  else if (m.includes("done") || m.includes("เสร็จ"))     cond.push(`status = Done`);
  else if (!m.includes("ทั้งหมด") && !m.includes("all")) cond.push(`status not in (Done, Closed, Resolved)`);
  const projectMatch = m.match(/\b(sr|dm2sp0|e1a2ep0|ntb|pt|pj|tmr)\b/i);
  if (projectMatch) cond.push(`project = "${projectMatch[1].toUpperCase()}"`);
  const jql    = cond.join(" AND ") + " ORDER BY status ASC, updated DESC";
  const data   = await jiraRequest(jql);
  const issues = data.issues || [];
  if (issues.length === 0) return "ไม่พบ issue ที่ตรงกับเงื่อนไขครับ";
  const rawList = issues.slice(0, 30).map((i) =>
    `- ${i.key}: ${i.fields.summary} | Status: ${i.fields.status?.name ?? "?"} | Priority: ${i.fields.priority?.name ?? "N/A"} | Due: ${i.fields.duedate ?? "ไม่กำหนด"}`
  ).join("\n");
  const prompt = `${systemPrompt || "คุณคือ QA Assistant"}\n\nสรุป Jira tasks ที่ได้รับมอบหมาย\nดู tasks ทั้งหมด ${issues.length} รายการ:\n${rawList}\nจัดกลุ่มสวยงาม: แบ่งตาม Status  Feature  ticket key ตอบพร้อม emoji bullet point`;
  return await askClaude(prompt);
}

async function handleProjectTasks(userMessage, project, ctx, systemPrompt) {
  const m    = userMessage.toLowerCase();
  const cond = [`project = "${project}"`];
  const showAll = m.includes("ทั้งหมด") || m.includes("all");
  if (!showAll) {
    if (m.includes("to test"))          cond.push(`status = "TO TEST"`);
    else if (m.includes("uat pending")) cond.push(`status = "UAT PENDING"`);
    else if (m.includes("done"))        cond.push(`status = Done`);
    else if (m.includes("overdue"))     cond.push(`duedate < startOfDay() AND status not in (Done, Closed, Resolved)`);
  }
  const assigneeMatch = m.match(/(?:ของ|by|assignee)\s+([฀-๿a-zA-Z]+)/);
  if (assigneeMatch) {
    const found = await searchJiraUser(assigneeMatch[1]);
    if (found) cond.push(`assignee = "${found}"`);
    else return `❌ ไม่พบ user "${assigneeMatch[1]}" ใน Jira ครับ`;
  }
  const jql    = cond.join(" AND ") + " ORDER BY status ASC, updated DESC";
  const issues = await jiraRequestAll(jql, ["summary","status","assignee","priority","duedate"], 300);
  if (issues.length === 0) return `ไม่พบ issue ใน project ${project} ครับ`;
  const rawList = issues.slice(0, 50).map((i) =>
    `- ${i.key}: ${i.fields.summary} | Status: ${i.fields.status?.name ?? "?"} | Assignee: ${i.fields.assignee?.displayName ?? "ไม่กำหนด"} | Priority: ${i.fields.priority?.name ?? "N/A"} | Due: ${i.fields.duedate ?? "ไม่กำหนด"}`
  ).join("\n");
  const more   = issues.length > 50 ? `\n(มีอีก ${issues.length - 50} issue)` : "";
  const prompt = `${systemPrompt || "คุณคือ QA Assistant"}\n\nสรุป Jira tasks ของ project ${project}\n${issues.length} รายการ:\n${rawList}${more}\nจัดกลุ่มสวยงาม: Status  Feature  key+Assignee ตอบพร้อม emoji bullet point`;
  return await askClaude(prompt);
}

async function handleExcelMatch(fileUrl, fileName, ctx) {
  const tmpPath     = path.join(os.tmpdir(), fileName);
  const outPath     = path.join(os.tmpdir(), "matched_" + fileName);
  const readScript  = path.join(os.tmpdir(), "qa_read.py");
  const writeScript = path.join(os.tmpdir(), "qa_write.py");
  const jiraKey     = getJiraKey(ctx);

  await downloadFile(fileUrl, tmpPath);
  console.log("Downloaded:", tmpPath);

  fs.writeFileSync(readScript, [
    "# -*- coding: utf-8 -*-",
    "import sys, io",
    "sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')",
    "sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')",
    "import pandas as pd, json",
    "try:",
    `    df = pd.read_excel(r'${tmpPath.replace(/\\/g, "\\\\")}', sheet_name='Test Case', header=2)`,
    "    rows = []",
    "    for i, row in df.iterrows():",
    "        tc_id   = str(row.get('Test Case\\nID', '') or '').strip()",
    "        summary = str(row.get('Summary', '') or '').strip()",
    "        module  = str(row.get('Module /\\nFeature', '') or '').strip()",
    "        upload  = str(row.get('Upload\\nJira', '') or '').strip()",
    "        if tc_id and tc_id.startswith('TC_') and summary and summary != 'nan':",
    "            rows.append({'idx': i, 'tc_id': tc_id, 'summary': summary, 'module': module, 'upload': upload})",
    "    print(json.dumps(rows, ensure_ascii=False))",
    "except Exception as e:",
    "    sys.stderr.write(str(e))",
    "    sys.exit(1)",
  ].join("\n"), "utf8");

  let testCases, result;
  try {
    result = execSync(`${PYTHON} "${readScript}"`, {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
  } catch (e) { return `❌ อ่าน Excel ล้มเหลว: ${e.message}`; }
  if (!result?.trim()) return "❌ Python ไม่มี output ครับ";
  try { testCases = JSON.parse(result.trim()); }
  catch (e) { return `❌ Parse JSON ล้มเหลว: ${e.message}`; }

  if (testCases.length === 0) return "❌ ไม่พบ Test Case ใน sheet 'Test Case' ครับ";

  let jiraIssues;
  try {
    jiraIssues = await jiraRequestAll(
      `project = ${jiraKey} AND issuetype in (Story, Subtask, "Sub-task") AND status not in (Done, Closed, Resolved) ORDER BY updated DESC`,
      ["summary","status","issuetype","parent"], 500
    );
  } catch (e) { return `❌ ดึง Jira issues ล้มเหลว: ${e.message}`; }

  const batchSize  = 15;
  const totalBatch = Math.ceil(testCases.length / batchSize);
  let allMatches   = [];
  for (let i = 0; i < testCases.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    console.log(`[Excel Match] Batch ${batchNum}/${totalBatch} (TC ${i + 1}–${Math.min(i + batchSize, testCases.length)} of ${testCases.length})`);
    const batch    = testCases.slice(i, i + batchSize);
    const tcList   = batch.map(tc => `TC_ID: ${tc.tc_id} | Summary: ${tc.summary} | Module: ${tc.module}`).join("\n");
    const jiraList = jiraIssues.slice(0, 200).map(j => `${j.key}: ${j.fields.summary}`).join("\n");
    const prompt   = `match Test Case กับ Jira ticket\nTest Cases:\n${tcList}\nJira:\n${jiraList}\nตอบ JSON array: [{"tc_id":"...","jira_key":"...","confidence":"high/medium/low"},...] ถ้าไม่มี jira_key=null\nตอบเฉพาะ JSON array เท่านั้น ไม่ใส่ข้อความอื่น ห้าม markdown`;
    try {
      let res     = await askClaude(prompt);
      let jsonStr = res.match(/\[[\s\S]*\]/)?.[0];
      let parsed;
      try { parsed = JSON.parse(jsonStr); }
      catch {
        res     = await askClaude(prompt);
        jsonStr = res.match(/\[[\s\S]*\]/)?.[0];
        parsed  = JSON.parse(jsonStr);
      }
      allMatches = allMatches.concat(parsed);
      console.log(`[Excel Match] Batch ${batchNum}/${totalBatch} done — matched ${parsed.length} TCs`);
    } catch (e) { console.error(`Batch ${batchNum} error:`, e.message); }
    if (i + batchSize < testCases.length) await new Promise(r => setTimeout(r, 2000));
  }

  allMatches = Object.values(allMatches.reduce((acc, m) => { if (!acc[m.tc_id] || m.confidence === "high") acc[m.tc_id] = m; return acc; }, {}));
  if (allMatches.length === 0) return "❌ ไม่สามารถ match ได้ครับ";

  const matchJsonStr = JSON.stringify(allMatches).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  fs.writeFileSync(writeScript, [
    "import openpyxl, json",
    `wb = openpyxl.load_workbook(r'${tmpPath.replace(/\\/g, "\\\\")}')`,
    "ws = wb['Test Case']",
    `matches = json.loads('${matchJsonStr}')`,
    "match_map = {m['tc_id']: m for m in matches}",
    "header_row = 3",
    "upload_col = tc_col = None",
    "for cell in ws[header_row]:",
    "    if cell.value and 'Upload' in str(cell.value): upload_col = cell.column",
    "    if cell.value and 'Test Case' in str(cell.value) and 'ID' in str(cell.value): tc_col = cell.column",
    "if upload_col and tc_col:",
    "    for row in ws.iter_rows(min_row=header_row+1):",
    "        tc_cell = row[tc_col-1]; upload_cell = row[upload_col-1]",
    "        tc_id = str(tc_cell.value or '').strip()",
    "        if tc_id in match_map:",
    "            m = match_map[tc_id]",
    "            if m['jira_key']:",
    `                upload_cell.value = '${JIRA_HOST}/browse/' + m['jira_key']`,
    `wb.save(r'${outPath.replace(/\\/g, "\\\\")}')`,
    "print('ok')",
  ].join("\n"), "utf8");

  try { execSync(`${PYTHON} "${writeScript}"`, { encoding: "utf8" }); }
  catch (e) { return `❌ เขียน Excel ล้มเหลว: ${e.message}`; }

  const highConf = allMatches.filter(m => m.jira_key && m.confidence === "high").length;
  const medConf  = allMatches.filter(m => m.jira_key && m.confidence === "medium").length;
  const noMatch  = allMatches.filter(m => !m.jira_key).length;

  const cardMap = {};
  for (const m of allMatches) {
    if (!m.jira_key) continue;
    if (!cardMap[m.jira_key]) cardMap[m.jira_key] = [];
    cardMap[m.jira_key].push(m.tc_id);
  }
  const cardEntries = Object.entries(cardMap).sort((a, b) => b[1].length - a[1].length);
  const totalCards  = cardEntries.length;
  const cardLines   = cardEntries.slice(0, 15).map(([key, tcs]) => {
    const range = tcs.length > 1 ? `${tcs[0]} ~ ${tcs[tcs.length - 1]}` : tcs[0];
    return `— ${key}   ${tcs.length} TC  (${range})`;
  });
  if (cardEntries.length > 15) cardLines.push(`...มีอีก ${cardEntries.length - 15} cards`);

  return [
    `✅ **Match เรียบร้อยแล้ว** [${jiraKey}] — ${allMatches.length} TC`,
    `Jira Cards: ${totalCards} cards | High: ${highConf} | Medium: ${medConf} | No match: ${noMatch}`,
    cardLines.join("\n"),
    `\n📁 ไฟล์ Excel พร้อม Jira link แนบมาด้วยครับ`,
    `__FILE__:${outPath}`,
  ].filter(Boolean).join("\n");
}

function detectIntent(msg) {
  const m           = msg.toLowerCase();
  const updateMatch = msg.match(/^([A-Z]+-\d+)\s+(pass|fail|block|blocked|retest|uat|testing|fix|fixing|ผ่าน|ไม่ผ่าน|บล็อค|done)(.*)/i);
  if (updateMatch) return { type: "update_issue", issueKey: updateMatch[1].toUpperCase(), action: updateMatch[2].toLowerCase(), comment: updateMatch[3].trim() };
  const manualMatch = msg.match(/^(TC_[A-Z0-9_]+)\s+(pass|fail|block|blocked)\b(.*)/i);
  if (manualMatch) return { type: "manual_update", tcId: manualMatch[1].toUpperCase(), action: manualMatch[2].toLowerCase(), comment: manualMatch[3].trim() };
  const testMatch = msg.match(/^test\s+(all|TC_[A-Z0-9_]+)/i);
  if (testMatch) return { type: "browser_test", target: testMatch[1].toUpperCase() };
  const retestMatch = msg.match(/^retest\s+(TC_[A-Z0-9_]+)/i);
  if (retestMatch) return { type: "browser_test", target: retestMatch[1].toUpperCase(), retest: true };
  const clearMatch = msg.match(/^clear[\s_]?cache(?:\s+(TC_[A-Z0-9_]+))?/i);
  if (clearMatch) return { type: "clear_cache", tcId: clearMatch[1] || null };
  if (/jira\s*(status|on|off|เปิด|ปิด)/i.test(m)) {
    const action = (m.includes(" on") || m.includes("เปิด")) ? "on" : (m.includes(" off") || m.includes("ปิด")) ? "off" : "status";
    return { type: "jira_toggle", action };
  }
  const JIRA_KW = ["jira","ticket","issue","task","งาน","status","assign","เช็ค","project","bug","defect","uat","pending","overdue","เกิน","due","sr-","ของฉัน","ของผม","ของหนู","ของเรา","ของตัวเอง","my task","list"];
  if (!JIRA_KW.some(k => m.includes(k))) return { type: "general" };
  if (m.includes("overdue") || m.includes("เกิน due") || m.includes("เกินกำหนด") || (m.includes("เกิน") && m.includes("วัน")) || (m.includes("due") && (m.includes("เกิน") || m.includes("pass") || m.includes("late")))) return { type: "overdue" };
  if (m.includes("uat") && (m.includes("pending") || m.includes("รอ") || m.includes("wait"))) return { type: "uat_pending" };
  const ds = m.match(/(?:due|ครบ|ถึง).{0,10}(\d+)\s*(?:วัน|day)/);
  if (ds) return { type: "due_soon", days: parseInt(ds[1]) };
  const isMyTask    = m.includes("ของผม") || m.includes("ของฉัน") || m.includes("ของหนู") || m.includes("ของเรา") || m.includes("ของตัวเอง") || m.includes("my task");
  const projectOnly = m.match(/(?:งาน|task|issue|list|ดึง|show)\s+(?:project\s+)?([a-z0-9\-]+)/i);
  if (projectOnly && !isMyTask) return { type: "project_tasks", project: projectOnly[1].toUpperCase() };
  return { type: "my_tasks" };
}

async function handleMessage(userMessage, discordUserId, fileUrl = null, fileName = null, sendProgress = null, ctxPayload = null) {
  const ctx          = ctxPayload?.context    || null;
  const systemPrompt = ctxPayload?.systemPrompt || null;

  if (fileUrl && fileName) {
    console.log("Excel match:", fileName);
    return await handleExcelMatch(fileUrl, fileName, ctx);
  }

  const intent = detectIntent(userMessage);
  console.log("Intent:", intent);

  if (intent.type === "clear_cache") return clearCache(intent.tcId);

  if (intent.type === "browser_test") {
    const appUrl = getAppUrl(ctx);
    if (!appUrl) return "❌ ไม่พบ APP_URL ครับ กรุณา config project ก่อน หรือตั้งค่า APP_URL ใน .env";

    const excelPath = getExcelPath(ctx) || findLatestExcel();
    if (!excelPath) return "❌ ไม่พบไฟล์ Excel ครับ กรุณาแนบไฟล์ Excel ก่อน";

    const tcFilter = intent.target !== "ALL" ? intent.target : null;
    let testCases;
    try { testCases = await readTestCasesFromExcel(excelPath, tcFilter); }
    catch (e) { return `❌ อ่าน Excel ล้มเหลว: ${e.message}`; }

    if (testCases.length === 0) return tcFilter ? `❌ ไม่พบ Test Case "${tcFilter}" ครับ` : "❌ ไม่พบ Test Case ใน Excel ครับ";
    if (intent.retest) testCases = testCases.map(tc => ({ ...tc, retest: true }));

    return await handleBrowserTest(testCases, sendProgress || (async () => {}), excelPath, ctx);
  }

  try {
    switch (intent.type) {
      case "jira_toggle": {
        const on = intent.action === "on";
        if (intent.action === "status") return `🔄 Jira update: **${getJiraOn(ctx) ? "ON ✅" : "OFF ❌"}**\nพิมพ์ \`jira on\` หรือ \`jira off\` เพื่อเปลี่ยนครับ`;
        jiraUpdateEnabled = on;
        return `🔄 Jira update: **${on ? "ON ✅" : "OFF ❌"}**`;
      }
      case "update_issue":  return await handleUpdateIssue(intent.issueKey, intent.action, intent.comment);
      case "manual_update": {
        const excelPath = getExcelPath(ctx) || findLatestExcel();
        if (!excelPath) return "❌ ไม่พบไฟล์ Excel ครับ กรุณาแนบไฟล์ Excel ก่อน";
        let rows;
        try { rows = await readTestCasesFromExcel(excelPath, intent.tcId); }
        catch (e) { return `❌ อ่าน Excel ล้มเหลว: ${e.message}`; }
        const tc = rows[0];
        if (!tc)          return `❌ ไม่พบ Test Case "${intent.tcId}" ใน Excel ครับ`;
        if (!tc.jira_key) return `❌ ไม่พบ jira_key สำหรับ ${intent.tcId} ใน Excel ครับ (คอลัมน์ Upload Jira ว่าง)`;
        const issueKey = tc.jira_key.split("/").pop();
        return await handleUpdateIssue(issueKey, intent.action, intent.comment);
      }
      case "overdue":       return await handleOverdue(ctx);
      case "uat_pending":   return await handleUatPending(userMessage, ctx);
      case "due_soon":      return await handleDueSoon(intent.days, ctx);
      case "my_tasks":      return await handleMyTasks(userMessage, ctx, systemPrompt);
      case "project_tasks": return await handleProjectTasks(userMessage, intent.project, ctx, systemPrompt);
      default:              return await askClaude(userMessage, systemPrompt);
    }
  } catch (err) {
    console.error("Error:", err.message);
    return `❌ เกิดข้อผิดพลาด: ${err.message}`;
  }
}

module.exports = { askClaude: handleMessage };
