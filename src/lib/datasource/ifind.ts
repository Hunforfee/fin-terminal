/**
 * 同花顺 iFinD Provider —— 预留插槽。
 *
 * 设计意图：iFinD 是本项目唯一能提供「真实三表财务数据 / 指数成分权重 /
 * 行业分类标准」的合规数据源，但它走 MCP 网关，且当前账号侧网关返回
 *   {"code":17008,"msg":"Connector \"ifind-mcp\" is not registered ..."}
 * 即连接器尚未真正可用（工具数为 0）。
 *
 * 因此这里做成「配置即启用」的插槽：
 *   1. 未配置 IFIND_BASE_URL 时，status() 返回 reserved，不影响主流程；
 *   2. 一旦配置（或在 MCP 网关注册成功后改为直连 MCP），
 *      实现 fetchFinancial / fetchIndustryPeers，上层无需改动即可用上真实财务数据。
 *
 * 替换点只有一处：本文件的 fetchFinancial()。
 */

import type { FinancialSummary, PeerRow } from './types';
import { fetchJson } from './http';

export const PROVIDER_NAME = 'ifind';

const BASE = process.env.IFIND_BASE_URL ?? '';
const TOKEN = process.env.IFIND_TOKEN ?? '';
/** MCP 网关地址（若走 MCP over HTTP 而非直连 REST） */
const MCP_URL = process.env.IFIND_MCP_URL ?? '';

export function isEnabled(): boolean {
  return Boolean(BASE && TOKEN) || Boolean(MCP_URL);
}

export interface IfindStatus {
  enabled: boolean;
  mode: 'rest' | 'mcp' | 'off';
  detail: string;
}

export function status(): IfindStatus {
  if (MCP_URL) {
    return {
      enabled: true,
      mode: 'mcp',
      detail: `已配置 MCP 网关 ${MCP_URL}（需网关侧完成连接器注册，否则返回 17008）`,
    };
  }
  if (BASE && TOKEN) {
    return { enabled: true, mode: 'rest', detail: `已配置 REST 端点 ${BASE}` };
  }
  return {
    enabled: false,
    mode: 'off',
    detail: '未配置 IFIND_BASE_URL / IFIND_MCP_URL，财务数据走恒等式派生',
  };
}

/**
 * 真实财务摘要（三表口径）。
 * 启用后返回 provenance='fetched'；未启用抛错，由上层降级到派生实现。
 */
export async function fetchFinancial(code: string, periods = 8): Promise<FinancialSummary> {
  if (!isEnabled()) throw new Error('ifind provider not configured');
  const url = `${BASE}/v1/financial/summary?code=${encodeURIComponent(code)}&periods=${periods}`;
  const json = await fetchJson<{
    periods: string[];
    revenue: number[];
    netProfit: number[];
    roe: number[];
    grossMargin: number[];
    debtRatio: number[];
  }>(url, { timeoutMs: 10000, headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });

  return {
    code,
    periods: json.periods,
    revenue: json.revenue,
    netProfit: json.netProfit,
    roe: json.roe,
    grossMargin: json.grossMargin,
    debtRatio: json.debtRatio,
    revenueGrowth: pctChange(json.revenue),
    profitGrowth: pctChange(json.netProfit),
    provenance: 'fetched',
    note: '同花顺 iFinD 真实财务数据',
  };
}

/** 行业可比公司（申万 / iFinD 行业分类） */
export async function fetchIndustryPeers(code: string, limit = 20): Promise<PeerRow[]> {
  if (!isEnabled()) throw new Error('ifind provider not configured');
  const url = `${BASE}/v1/industry/peers?code=${encodeURIComponent(code)}&limit=${limit}`;
  const json = await fetchJson<{ peers: PeerRow[] }>(url, {
    timeoutMs: 10000,
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  return json.peers ?? [];
}

function pctChange(arr: number[]): (number | null)[] {
  return arr.map((v, i) => {
    if (i + 1 >= arr.length) return null;
    const prev = arr[i + 1]; // iFinD 通常按报告期倒序返回
    if (!prev) return null;
    return ((v - prev) / Math.abs(prev)) * 100;
  });
}
