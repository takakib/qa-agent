const { chromium } = require('D:\\QA_Agent\\node_modules\\playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Users\\admin\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe'
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

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
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign In');
      if (btn) btn.click();
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    try {
      const allBtns = await page.locator('button').all();
      for (const btn of allBtns) {
        const text = await btn.textContent();
        if (text && (text.includes('Confirm') || text.includes('ยืนยัน'))) {
          await btn.click();
          break;
        }
      }
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
    } catch (e) {}

    await page.evaluate(() => {
      const links = [...document.querySelectorAll('a, button, [role=menuitem]')];
      const link = links.find(el => el.textContent.includes('user') || el.textContent.includes('User') || el.href?.includes('user-management'));
      if (link) link.click();
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => b.textContent.trim() === 'Roles');
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);

    const roleExists = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].some(el => el.children.length === 0 && el.textContent.trim() === 'RDT_Adjuster');
    });
    if (!roleExists) {
      await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add Role') || b.textContent.includes('เพิ่ม Role')); if(b) b.click(); });
      await page.waitForTimeout(1000);

      await page.evaluate(() => {
        const inputs = document.querySelectorAll('div[role="dialog"] input[type="text"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        inputs.forEach(el => {
          el.focus();
          setter.call(el, 'RDT_Adjuster');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const boxes = document.querySelectorAll('div[role="dialog"] input[type="checkbox"]');
        if (boxes[1] && !boxes[1].checked) boxes[1].click();
        if (boxes[2] && !boxes[2].checked) boxes[2].click();
      });
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('div[role="dialog"] button')];
        const save = btns.find(b => !b.disabled && /^(เพิ่ม|บันทึก|Add|Save|Create)\s*Role$/i.test(b.textContent.trim()));
        if (save) { save.click(); return; }
        const enabled = btns.filter(b => !b.disabled);
        if (enabled.length) enabled[enabled.length - 1].click();
      });
      await page.waitForTimeout(2000);

      await page.locator('button.swal2-confirm').click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);

      await page.locator('div[role="dialog"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    await page.waitForTimeout(3000);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Groups'); if(b) b.click(); });
    await page.waitForTimeout(2000);

    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add Group') || b.textContent.includes('เพิ่ม Group')); if(b) b.click(); });
    await page.waitForTimeout(1000);

    await page.evaluate((v) => {
      const ins = document.querySelectorAll('div[role="dialog"] input[type="text"]');
      if (ins[0]) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        ins[0].focus();
        s.call(ins[0], v);
        ins[0].dispatchEvent(new Event('input', { bubbles: true }));
        ins[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 'RDT_Adjusters');
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const d = document.querySelector('div[role="dialog"]');
      if (!d) return;
      for (const el of d.querySelectorAll('*')) {
        if (el.children.length === 0 && el.textContent.trim() === 'RDT_Adjuster') {
          let p = el.parentElement;
          while (p && p !== d) {
            const cb = p.querySelector('input[type="checkbox"]');
            if (cb) { if (!cb.checked) cb.click(); return; }
            p = p.parentElement;
          }
        }
      }
      const boxes = d.querySelectorAll('input[type="checkbox"]');
      if (boxes[0] && !boxes[0].checked) boxes[0].click();
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('div[role="dialog"] button')];
      const save = btns.find(b => !b.disabled && /^(เพิ่ม|บันทึก|Add|Save|Create)\s*Group$/i.test(b.textContent.trim()));
      if (save) { save.click(); return; }
      const enabled = btns.filter(b => !b.disabled);
      if (enabled.length) enabled[enabled.length - 1].click();
    });
    await page.waitForTimeout(2000);

    await page.locator('button.swal2-confirm').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);

    try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_) {}
    await browser.close();
    process.exit(0);

  } catch (err) {
    console.error('FAIL: ' + err.message);
    try { await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false }); } catch (_) {}
    await browser.close();
    process.exit(1);
  }
})();
