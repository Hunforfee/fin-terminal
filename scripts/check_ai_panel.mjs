import { chromium } from 'playwright';

const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:3000';
const TARGETS = (process.env.TARGETS || '600415,300498,600519,300750,002594,601318,000333').split(',');
const FALLBACK = process.env.FALLBACK || '600036'; // 非预生成，验证回退

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function checkStock(code, expectPregen) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));
  await page.goto(`${BASE}/stock/${code}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'AI 分析' }).first().click();
  await page.waitForSelector('text=公司深度解析', { timeout: 15000 });
  await page.waitForTimeout(2200);

  const body = await page.locator('body').innerText();
  // 并排改造：维度 Tab 已移除，营收构成为多列并排卡片
  const tabButtons = await page
    .getByRole('button', { name: /按行业|按产品|按地区/ })
    .count();
  const gridCols = await page
    .locator('section:has-text("营收构成") div.grid > div')
    .count();
  const bars = await page.locator('div.h-1 > div').count();

  const checks = {
    '深度解析': body.includes('公司深度解析'),
    '营收构成': body.includes('营收构成'),
    '无维度Tab': tabButtons === 0,
    '并排卡片': gridCols >= 1,
    '占比条': bars > 0,
    '无研报主要观点': !body.includes('研报主要观点'),
  };
  if (expectPregen) {
    checks['核心优势'] = body.includes('核心优势与护城河');
    checks['竞争对手'] = body.includes('竞争对手对比');
    checks['市场观点'] = body.includes('市场观点');
    checks['主流看好'] = body.includes('主流看好');
    checks['分歧与风险'] = body.includes('分歧与风险');
    checks['正文够长'] = body.length > 1800;
  }
  console.log(`\n=== ${code} (pregen=${expectPregen}) ===`);
  for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + ' ' + k);
  console.log('并排维度卡:', gridCols, '| 占比条:', bars, '| 文本:', body.length);
  console.log('errors:', errors.length ? errors.slice(0, 3).join(' | ') : 'none');
  await page.screenshot({ path: `/workspace/ai_${code}.png`, fullPage: true });
  await page.close();
  return Object.values(checks).every(Boolean) && errors.length === 0;
}

const results = [];
for (const c of TARGETS) results.push(await checkStock(c, true));
results.push(await checkStock(FALLBACK, false));
await browser.close();
const ok = results.every(Boolean);
console.log('\nRESULT:', ok ? 'ALL PASS' : 'SOME FAIL');
process.exit(ok ? 0 : 1);
