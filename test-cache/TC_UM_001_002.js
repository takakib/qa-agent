const { chromium } = require('D:\\QA_Agent\\node_modules\\playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Users\\admin\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe'
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto('http://192.168.0.138:8181/');
    await page.waitForSelector('input', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.locator('input').first().click();
    await page.locator('input').first().clear();
    await page.keyboard.type('dev01', { delay: 50 });
    await page.waitForTimeout(300);
    await page.locator('input[type=password]').click();
    await page.keyboard.type('P@ssw0rd', { delay: 50 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = b.textContent.trim();
        return t === 'เข้าสู่ระบบ' || /^(login|sign in)$/i.test(t);
      });
      if (btn) btn.click();
    });
    await page.waitForLoadState('networkidle');

    try {
      await page.waitForTimeout(1500);
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => {
          const t = b.textContent.trim();
          return t.includes('ยืนยัน') || t.includes('Confirm Sign In') || t.includes('Confirm');
        });
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clicked) await page.waitForLoadState('networkidle');
    } catch (e) {}

    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle');
    await page.goto('http://192.168.0.138:8181/dashboard/user-management');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Roles');
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);

    // CASE 1: ไม่กรอก Role Name ปุ่มต้อง disabled
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = b.textContent.trim();
        return /เพิ่ม Role/i.test(t) || /Add Role/i.test(t);
      });
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);

    const isDisabled1 = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const saveBtn = buttons.find(b => {
        const t = b.textContent.trim();
        return t === 'เพิ่ม Role' || t === 'Add Role';
      });
      return saveBtn ? (
        saveBtn.disabled ||
        saveBtn.getAttribute('disabled') !== null ||
        saveBtn.classList.contains('disabled') ||
        saveBtn.getAttribute('aria-disabled') === 'true'
      ) : false;
    });
    if (!isDisabled1) {
      console.error('FAIL: Case 1 — ปุ่มเพิ่ม Role ไม่ถูก disabled เมื่อไม่กรอก Role Name');
      try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_e) {}
      await browser.close();
      process.exit(1);
    }

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const cancelBtn = buttons.find(b => b.textContent.trim() === 'ยกเลิก');
      if (cancelBtn) cancelBtn.click();
    });
    await page.waitForTimeout(1000);

    // CASE 2: กรอก Role Name แต่ไม่เลือก Menu ปุ่มต้อง disabled
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = b.textContent.trim();
        return /เพิ่ม Role/i.test(t) || /Add Role/i.test(t);
      });
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);

    await page.evaluate((val) => {
      const inputs = document.querySelectorAll('div[role=dialog] input[type=text]');
      if (inputs[0]) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inputs[0], val);
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 'Test Validation');
    await page.waitForTimeout(300);

    await page.evaluate((val) => {
      const inputs = document.querySelectorAll('div[role=dialog] input[type=text]');
      if (inputs[1]) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inputs[1], val);
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 'Test Validation');
    await page.waitForTimeout(500);

    const isDisabled2 = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const saveBtn = buttons.find(b => {
        const t = b.textContent.trim();
        return t === 'เพิ่ม Role' || t === 'Add Role';
      });
      return saveBtn ? saveBtn.disabled : false;
    });
    if (!isDisabled2) {
      console.error('FAIL: Case 2 — ปุ่มเพิ่ม Role ไม่ถูก disabled เมื่อไม่เลือก Menu');
      try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_e) {}
      await browser.close();
      process.exit(1);
    }

   await page.waitForTimeout(5000);
    try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_e) {}
    await browser.close();
    process.exit(0);

  } catch (err) {
    await page.waitForTimeout(5000);
    console.error('FAIL: ' + err.message);
    try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_e) {}
    await browser.close();
    process.exit(1);
  }
})();
