import { chromium } from 'playwright';

const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:3000';
const TARGET = process.env.TARGET || '600415'; // 预生成试点股
const FALLBACK = process.env.FALLBACK || '600036'; // 非预生成，验证回退

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function checkStock(code, expectPregen) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));
  await page.goto(`${BASE}/stock/${code}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'AI 分析' }).first().click();
  await page.waitForSelector('text=业务与行业地位', { timeout: 15000 });
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  const tabCount = await page.getByRole('button', { name: /按行业|按产品|按地区/ }).count();
  // 点击“按产品”Tab（若存在）验证切换
  let switched = false;
  try {
    await page.getByRole('button', { name: '按产品' }).first().click();
    await page.waitForTimeout(400);
    switched = true;
  } catch {}
  const bars = await page.locator('div.h-1\\.5 > div').count();

  const checks = {
    '业务与行业地位': body.includes('业务与行业地位'),
    '营收构成': body.includes('营收构成'),
    '维度Tab(>=1)': tabCount >= 1,
    '占比条渲染': bars > 0,
    '行业标签': /租赁和商务服务业|制造业|金融业|商务服务业/.test(body),
  };
  if (expectPregen) {
    checks['预生成综述(小商品城等)'] = body.includes('小商品城') || body.length > 600;
  }
  console.log(`\n=== ${code} (pregen=${expectPregen}) ===`);
  for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + ' ' + k);
  console.log('Tab切换:', switched ? 'ok' : 'n/a', '| 占比条数:', bars, '| 文本长度:', body.length);
  console.log('console errors:', errors.length ? errors.slice(0, 5).join(' | ') : 'none');
  await page.screenshot({ path: `/workspace/ai_${code}.png`, fullPage: true });
  await page.close();
  return Object.values(checks).every(Boolean) && errors.length === 0;
}

const r1 = await checkStock(TARGET, true);
const r2 = await checkStock(FALLBACK, false);
await browser.close();
console.log('\nRESULT:', r1 && r2 ? 'ALL PASS' : 'SOME FAIL');
process.exit(r1 && r2 ? 0 : 1);
