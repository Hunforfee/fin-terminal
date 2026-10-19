import { chromium } from 'playwright';

const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:3000';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));

await page.goto(`${BASE}/stock/600415`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);

// 点击 AI 分析 按钮
const btn = page.getByRole('button', { name: 'AI 分析' });
await btn.first().click();
await page.waitForSelector('text=主营业务', { timeout: 15000 });
await page.waitForTimeout(2500); // 等 /api/analysis 返回

const bodyText = await page.locator('body').innerText();
const checks = {
  '主营业务标题': bodyText.includes('主营业务'),
  '经营评述': bodyText.includes('经营评述'),
  '按产品构成': bodyText.includes('主营构成 · 按产品'),
  '按地区构成': bodyText.includes('主营构成 · 按地区'),
  '按行业构成': bodyText.includes('主营构成 · 按行业'),
  '所属行业标签': bodyText.includes('租赁和商务服务业'),
  '市场商位使用业务': bodyText.includes('市场商位使用'),
  '境外地区': bodyText.includes('境外'),
};
console.log('--- checks ---');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + ' ' + k);
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'none');

await page.screenshot({ path: '/workspace/ai_panel_deep.png', fullPage: true });
console.log('screenshot: /workspace/ai_panel_deep.png');

await browser.close();
