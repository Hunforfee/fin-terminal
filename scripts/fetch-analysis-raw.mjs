#!/usr/bin/env node
/**
 * 抓取个股 F10 真实数据，供「业务与行业地位」预生成综述使用。
 * 输出：src/data/analyses/_raw/{code}.json
 *
 * 数据来源（东方财富公开 F10，无需鉴权）：
 *   CompanySurvey    → 行业(INDUSTRYCSRC1) / 公司概况(ORG_PROFILE) / 上市日期
 *   BusinessAnalysis → 经营评述(jyps.BUSINESS_REVIEW) / 主营构成三维(zygcfx) / 经营范围
 *   datacenter       → 主要财务指标（营收/净利/同比/毛利率，尽力获取）
 *
 * 用法：node scripts/fetch-analysis-raw.mjs 600415 600519 ...
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'data', 'analyses', '_raw');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REF = 'https://emweb.securities.eastmoney.com/';

function get(url, ref = REF) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { Referer: ref, 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          const enc = r.headers['content-encoding'];
          let body;
          try {
            body =
              enc === 'gzip'
                ? zlib.gunzipSync(buf).toString('utf8')
                : enc === 'deflate'
                  ? zlib.inflateSync(buf).toString('utf8')
                  : buf.toString('utf8');
          } catch {
            body = buf.toString('utf8');
          }
          res(body);
        });
      },
    );
    req.on('error', rej);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function cleanDate(raw) {
  if (typeof raw !== 'string') return null;
  const d = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

const MAINOP = { '1': '按行业', '2': '按产品', '3': '按地区' };

async function fetchFinance(code, prefix) {
  // 主要财务指标：最新报告期 营收/净利/同比/毛利率
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAIN&columns=SECURITY_CODE,REPORT_DATE,TOTAL_OPERATE_INCOME,YSTZ,PARENT_NETPROFIT,SJLTZ,XSMLL&filter=(SECURITY_CODE:%22${prefix}${code}%22)&pageSize=3&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC`;
  try {
    const j = JSON.parse(await get(url, 'https://emweb.securities.eastmoney.com/'));
    const rows = j?.result?.data || j?.data || [];
    if (!rows.length) return null;
    const r = rows[0];
    return {
      reportDate: cleanDate(r.REPORT_DATE),
      revenue: r.TOTAL_OPERATE_INCOME ?? null,
      revenueYoY: r.YSTZ ?? null,
      netProfit: r.PARENT_NETPROFIT ?? null,
      netProfitYoY: r.SJLTZ ?? null,
      grossMargin: r.XSMLL ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchOne(code) {
  const prefix = /^(4|8|9)/.test(code) ? 'BJ' : code.startsWith('6') ? 'SH' : 'SZ';
  const pj = `${prefix}${code}`;
  const [csRaw, baRaw] = await Promise.all([
    get(`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${pj}`).catch(() => '{}'),
    get(`https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${pj}`).catch(() => '{}'),
  ]);
  const cs = JSON.parse(csRaw);
  const ba = JSON.parse(baRaw);

  const jbzl = Array.isArray(cs?.jbzl) ? cs.jbzl[0] : undefined;
  const zyfw = Array.isArray(ba?.zyfw) ? ba.zyfw[0] : undefined;
  const jyps = Array.isArray(ba?.jyps) ? ba.jyps[0] : undefined;

  const review = jyps?.BUSINESS_REVIEW ? String(jyps.BUSINESS_REVIEW).trim() : null;
  const reviewDate = cleanDate(jyps?.REPORT_DATE);

  const rows = (Array.isArray(ba?.zygcfx) ? ba.zygcfx : []).filter(
    (r) => r && r.MAINOP_TYPE != null && r.ITEM_NAME,
  );
  const groups = [];
  for (const t of ['1', '2', '3']) {
    const tr = rows
      .filter((r) => String(r.MAINOP_TYPE) === t)
      .sort((a, b) => String(b.REPORT_DATE || '').localeCompare(String(a.REPORT_DATE || '')));
    if (!tr.length) continue;
    const date = cleanDate(tr[0].REPORT_DATE);
    const items = tr
      .filter((r) => cleanDate(r.REPORT_DATE) === date)
      .slice(0, 6)
      .map((r) => ({
        name: r.ITEM_NAME,
        income: typeof r.MAIN_BUSINESS_INCOME === 'number' ? r.MAIN_BUSINESS_INCOME : null,
        incomeRatio: typeof r.MBI_RATIO === 'number' ? r.MBI_RATIO : null,
        grossMargin: typeof r.GROSS_RPOFIT_RATIO === 'number' ? r.GROSS_RPOFIT_RATIO : null,
      }));
    groups.push({ label: MAINOP[t], date, items });
  }

  const finance = await fetchFinance(code, prefix);

  return {
    code,
    name: jbzl?.SECURITY_NAME_ABBR ?? null,
    industry: jbzl?.INDUSTRYCSRC1 ?? null,
    listingDate: jbzl?.LISTING_DATE ?? null,
    profile: jbzl?.ORG_PROFILE ? String(jbzl.ORG_PROFILE).trim() : null,
    scope: zyfw?.BUSINESS_SCOPE ? String(zyfw.BUSINESS_SCOPE).trim() : null,
    review,
    reviewDate,
    groups,
    finance,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

async function main() {
  const codes = process.argv.slice(2);
  if (!codes.length) {
    console.error('用法: node scripts/fetch-analysis-raw.mjs 600415 600519 ...');
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  for (const code of codes) {
    try {
      const data = await fetchOne(code);
      const out = join(OUT_DIR, `${code}.json`);
      await writeFile(out, JSON.stringify(data, null, 2), 'utf8');
      const revLen = data.review?.length ?? 0;
      const fin = data.finance ? `${data.finance.reportDate}` : '无财务';
      console.log(`✓ ${code} ${data.name || ''} | 行业:${data.industry || '-'} | 经营评述:${revLen}字 | 三维:${data.groups.length} | 财务:${fin}`);
    } catch (e) {
      console.error(`✗ ${code} 失败: ${e.message}`);
    }
  }
}

main();
