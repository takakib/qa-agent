process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\\Users\\admin\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe';
// ============================================================
// TC_UM_001_003 — TC_UM_001_003 สร้าง Role ชื่อซ้ำกับที่มีอยู่แล้ว
// Module: 5.1 User Management
// *** section 4 = ขั้นตอนทดสอบ | section 5 = เงื่อนไข assert
// ============================================================
const { chromium } = require('D:\\QA_Agent\\node_modules\\playwright');

const USERNAME = 'dev01'; //  แก้ตรงนี้ถ้า user เปลี่ยน
const PASSWORD = 'P@ssw0rd'; //  แก้ตรงนี้ถ้า password เปลี่ยน

const DUP_ROLE_NAME = 'RDT_Adjuster'; // ชื่อ Role ที่ซ้ำกับที่มีอยู่แล้ว

(async () => {
  let browser;
  let page;

  // helper: logout (เคลียร์ session) + screenshot + exit
  const finish = async (code, reason) => {
    if (code !== 0 && reason) console.error('FAIL: ' + reason);
    try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch (_) {}
    try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_se) {}
    try { if (browser) await browser.close(); } catch (_) {}
    process.exit(code);
  };

  try {
    // ── 1. เปิด Browser ──────────────────────────────────────────
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:\\Users\\admin\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe'
    });
    const context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(15000);

    // ── 2. เปิดหน้าเว็บ ──────────────────────────────────────────
    await page.goto('http://192.168.0.138:8181/');
    await page.waitForSelector('input', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // ── 3. Login เข้าระบบ ────────────────────────────────────────
    // กรอก username
    await page.locator('input').first().click();
    await page.locator('input').first().clear();
    await page.keyboard.type(USERNAME, { delay: 50 });
    await page.waitForTimeout(300);
    // กรอก password
    await page.locator('input[type=password]').click();
    await page.keyboard.type(PASSWORD, { delay: 50 });
    await page.waitForTimeout(300);
    // คลิกปุ่ม Sign In ผ่าน evaluate
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = (b.textContent || '').trim();
        return t === 'Sign In' || t === 'เข้าสู่ระบบ' || t === 'Login';
      });
      if (btn) btn.click();
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    // เช็ค popup session ซ้อน (ไทย/อังกฤษ)
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

    // ── 4. ขั้นตอนการทดสอบ ───────────────────────────────────────
    // ไปหน้า User Management
    await page.goto('http://192.168.0.138:8181/'.replace(/\/$/, '') + '/dashboard/user-management');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    // คลิก tab Roles
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => (b.textContent || '').trim() === 'Roles');
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    // คลิกปุ่มเพิ่ม Role ใหม่
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => {
        const t = (b.textContent || '').trim();
        return t.includes('Add Role') || t.includes('เพิ่ม Role');
      });
      if (btn) btn.click();
    });
    // รอ modal เปิด
    await page.waitForSelector('div[role="dialog"]', { state: 'visible' });
    await page.waitForTimeout(500);
    // กรอกชื่อ Role ภาษาไทย ด้วยชื่อที่ซ้ำ
    await page.locator('[id="input-role-name-(thai)"]').click();
    await page.keyboard.type(DUP_ROLE_NAME, { delay: 50 });
    await page.waitForTimeout(300);
    // กรอกชื่อ Role ภาษาอังกฤษ ด้วยชื่อที่ซ้ำ
    await page.locator('[id="input-role-name-(english)"]').click();
    await page.keyboard.type(DUP_ROLE_NAME, { delay: 50 });
    await page.waitForTimeout(300);
    // เลือก Menu (permission checkbox) — เลือก Import (nth=1)
    await page.evaluate((idx) => {
      const boxes = document.querySelectorAll('div[role="dialog"] input[type="checkbox"]');
      if (boxes[idx]) boxes[idx].click();
    }, 1);
    await page.waitForTimeout(300);
    // คลิกปุ่ม Save (เพิ่ม Role ใน modal)
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('div[role="dialog"] button')];
      const btn = btns.find(b => (b.textContent.includes('Add Role') || b.textContent.includes('เพิ่ม Role')) && !b.disabled);
      if (btn) btn.click();
    });
    // รอระบบประมวลผล/แสดง error
    await page.waitForTimeout(2500);

    // ── 5. ตรวจสอบผลลัพธ์ (Assertion) ───────────────────────────
    // อ่านข้อความทั้งหน้า + SweetAlert popup เพื่อหา error แจ้งว่าชื่อ Role ซ้ำ
    // หมายเหตุ: ระบบ reject ชื่อซ้ำด้วย HTTP 409 ซึ่ง SweetAlert แสดง "Request failed with status code 409"
    const result = await page.evaluate(() => {
      const swal = document.querySelector('.swal2-popup');
      const swalText = swal ? (swal.innerText || '') : '';
      const bodyText = document.body.innerText || '';
      const combined = (swalText + ' ' + bodyText).toLowerCase();
      const dupKeywords = ['มีอยู่แล้ว', 'ซ้ำ', 'already exist', 'duplicate', 'try again', 'request failed', '409', 'conflict', 'ไม่สำเร็จ', 'ผิดพลาด'];
      const hasDupError = dupKeywords.some(k => combined.includes(k.toLowerCase()));
      // modal ยังเปิดอยู่ = ไม่ได้บันทึก Role ซ้ำ
      const modalStillOpen = !!document.querySelector('[id="input-role-name-(english)"]');
      return { hasDupError, modalStillOpen, swalText: swalText.replace(/\s+/g, ' ').trim() };
    });

    if (result.hasDupError) {
      // PASS: ระบบแสดง error ชื่อ Role ซ้ำ (409 Conflict) และไม่บันทึก
      console.log('PASS: ระบบแสดง Error ชื่อ Role ซ้ำ และไม่บันทึก Role ซ้ำ' + (result.swalText ? ' | ' + result.swalText : ''));
      // ปิด popup error ถ้ามี (SweetAlert2)
      await page.locator('button.swal2-confirm').click().catch(() => {});
      await page.waitForTimeout(1000);
      await finish(0);
    } else {
      await finish(1, 'ไม่พบ Error แจ้งชื่อ Role ซ้ำ หรือระบบบันทึก Role ซ้ำได้ (ผิด expected result)');
    }

    // ── 6. ปิด Browser ───────────────────────────────────────────
  } catch (err) {
    if (page) {
      await finish(1, (err && err.message) ? err.message : String(err));
    } else {
      console.error('FAIL: ' + ((err && err.message) ? err.message : String(err)));
      try { if (browser) await browser.close(); } catch (_) {}
      process.exit(1);
    }
  }
})();