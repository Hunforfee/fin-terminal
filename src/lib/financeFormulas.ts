import { personalStorage } from './personalStorage';
/**
 * 自定义指标（公式）：用户用已有字段（bs_/pl_/cf_ 科目与财务指标 key）通过
 * 加减乘除组合出新数据项，如「货币资金 / 流动负债合计」。
 *
 * - 表达式以字段 key 直接书写，如 `bs_货币资金 / bs_流动负债合计 * 100`
 * - 前端逐期计算（companies[].series 已在前端），null 传播：任一操作数缺失 → 该期为 null
 * - 安全校验：替换字段占位后，表达式只允许 数字/四则运算符/括号/空白
 */

export interface Formula {
  id: string;
  name: string;
  expr: string;
  /** 展示单位：空=数值，pct=百分比，yuan=元，wan=万元 */
  unit: '' | 'pct' | 'yuan' | 'wan';
  /** 内置预设（不可编辑，删除=隐藏） */
  preset?: boolean;
  /** 未披露值按 0 处理（适用于「未披露=零余额」的负债类科目） */
  nullAsZero?: boolean;
  description?: string;
  positiveDenominator?: string;
}

/**
 * 利息保障倍数采用费用化利息口径：(利润总额 + 费用化利息费用) / 费用化利息费用。
 * 金额取东方财富利润表 TOTAL_PROFIT / FE_INTEREST_EXPENSE，统一万元。
 * 禁止用净财务费用、现金流附注的财务费用代替利息费用；缺失或非正利息为缺失值。
 * 此口径不含资本化利息，与债券披露的含资本化利息保障倍数应分开比较。
 * 定义参考：https://www.csrc.gov.cn/ningxia/c105510/c7398729/content.shtml
 */
export const PRESET_FORMULAS: Formula[] = [
  {
    id: 'p-debt-ratio',
    name: '资产负债率',
    expr: 'bs_负债合计 / bs_资产总计 * 100',
    unit: 'pct',
    preset: true,
  },
  {
    id: 'p-interest-debt-ratio',
    name: '有息负债率',
    expr: 'interestDebtRatio',
    unit: 'pct',
    preset: true,
    description: '采用东方财富 INTEREST_DEBT_RATIO（有息负债 / 总资产），按报告期对齐；不是只加总五项借款的窄口径。合并范围含金融子公司时可能包含其融资负债，缺失不按零处理。',
  },
  {
    id: 'p-cash-to-debt',
    name: '现金/有息债',
    expr:
      '(bs_货币资金 + bs_交易性金融资产) / (bs_短期借款 + bs_一年内到期的非流动负债 + bs_长期借款 + bs_应付债券 + bs_租赁负债)',
    unit: '',
    preset: true,
  },
  {
    id: 'p-interest-coverage',
    name: '利息保障倍数',
    expr: '(pl_利润总额 + pl_利息费用) / pl_利息费用',
    unit: '',
    preset: true,
    positiveDenominator: 'pl_利息费用',
    description: '费用化利息口径：(利润总额 + 利息费用) / 利息费用；不含资本化利息。利润总额与利息费用来自东方财富同一期利润表；缺失或无正利息费用时不计算。',
  },
  // ---- 以下 5 条为扩展主流指标（周转率用期末值口径，非平均余额口径） ----
  {
    id: 'p-gross-margin',
    name: '毛利率',
    expr: '(pl_营业收入 - pl_营业成本) / pl_营业收入 * 100',
    unit: 'pct',
    preset: true,
  },
  {
    id: 'p-inventory-turnover',
    name: '存货周转率（期末余额口径）',
    expr: 'pl_营业成本 / bs_存货',
    unit: '',
    preset: true,
    description: '当期累计营业成本 / 期末存货；未年化，不等同于使用平均存货余额的周转率。',
  },
  {
    id: 'p-receivable-turnover',
    name: '应收账款周转率（期末余额口径）',
    expr: 'pl_营业收入 / bs_应收账款',
    unit: '',
    preset: true,
    description: '当期累计营业收入 / 期末应收账款；未年化，不等同于使用平均应收账款余额的周转率。',
  },
  {
    id: 'p-fcf',
    name: '自由现金流',
    expr:
      'cf_经营活动产生的现金流量净额 - cf_购建固定资产、无形资产和其他长期资产所支付的现金',
    unit: 'wan',
    preset: true,
  },
  {
    id: 'p-equity-multiplier',
    name: '权益乘数',
    expr: 'bs_资产总计 / (bs_资产总计 - bs_负债合计)',
    unit: '',
    preset: true,
  },
];

const LS_KEY = 'fin.financeFormulas';

export const FORMULA_PREFIX = 'fx_';

export function formulaKey(id: string): string {
  return `${FORMULA_PREFIX}${id}`;
}

export function loadFormulas(): Formula[] {
  try {
    const raw = personalStorage.getItem(LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter(
          (f) => f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.expr === 'string',
        );
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveFormulas(list: Formula[]): void {
  try {
    personalStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const LS_HIDDEN_PRESETS = 'fin.financeFormulas.hiddenPresets';

/** 合并预设 + 用户公式（用户删除的预设记入隐藏列表） */
export function mergedFormulas(): Formula[] {
  let hidden: string[] = [];
  try {
    hidden = JSON.parse(personalStorage.getItem(LS_HIDDEN_PRESETS) ?? '[]');
  } catch {
    /* ignore */
  }
  const user = loadFormulas().filter((f) => !f.preset);
  return [...PRESET_FORMULAS.filter((p) => !hidden.includes(p.id)), ...user];
}

export function hidePreset(id: string): void {
  try {
    const hidden: string[] = JSON.parse(personalStorage.getItem(LS_HIDDEN_PRESETS) ?? '[]');
    if (!hidden.includes(id)) hidden.push(id);
    personalStorage.setItem(LS_HIDDEN_PRESETS, JSON.stringify(hidden));
  } catch {
    /* ignore */
  }
}

/** 表达式中出现的字段 key（按长度降序，避免「流动负债合计」截胡「负债合计」类问题） */
export function fieldsInExpr(expr: string, allKeys: string[]): string[] {
  return allKeys
    .filter((k) => expr.includes(k))
    .sort((a, b) => b.length - a.length);
}

export interface ExprCheck {
  ok: boolean;
  error?: string;
  /** 校验通过时使用的字段 key */
  keys: string[];
}

/** 校验表达式：字段 key 必须存在；其余部分只能是数字与四则运算符 */
export function checkExpr(expr: string, allKeys: string[]): ExprCheck {
  const trimmed = expr.trim();
  if (!trimmed) return { ok: false, error: '表达式为空', keys: [] };

  const keys = fieldsInExpr(trimmed, allKeys);
  let sanitized = trimmed;
  keys.forEach((k, i) => {
    sanitized = sanitized.split(k).join(`@${i}@`);
  });

  // 余下内容只允许 数字、运算符、括号、逗号、空白、占位符
  if (!/^[\d+\-*/().,\s@]*$/.test(sanitized)) {
    return { ok: false, error: '表达式中含无法识别的字符（只支持字段名、数字与 + - * / 括号）', keys };
  }
  // 括号配对
  let depth = 0;
  for (const ch of sanitized) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return { ok: false, error: '括号不配对', keys };
  }
  if (depth !== 0) return { ok: false, error: '括号不配对', keys };
  if (keys.length === 0) return { ok: false, error: '表达式中未引用任何字段', keys };
  return { ok: true, keys };
}

/**
 * 逐期计算公式。series 为该公司 key→数值序列；期数 n 与序列对齐。
 * nullAsZero=true 时缺失值按 0 参与计算（「未披露=零余额」口径，用于负债类预设公式）；
 * 否则任一操作数缺失 → 该期 null。除零/非法结果 → null。
 */
export function evalFormula(
  expr: string,
  series: Record<string, (number | null)[]>,
  n: number,
  opts?: { nullAsZero?: boolean; positiveDenominator?: string },
): (number | null)[] {
  const nullAsZero = opts?.nullAsZero ?? false;
  const allKeys = Object.keys(series);
  const check = checkExpr(expr, allKeys);
  if (!check.ok) return Array(n).fill(null);

  const { keys } = check;
  const params = keys.map((_, i) => `a${i}`);
  let body = expr.trim();
  keys.forEach((k, i) => {
    body = body.split(k).join(`a${i}`);
  });

  let fn: (...args: number[]) => number;
  try {
    fn = new Function(...params, `"use strict"; return (${body});`) as (...args: number[]) => number;
  } catch {
    return Array(n).fill(null);
  }

  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const denominator = opts?.positiveDenominator ? series[opts.positiveDenominator]?.[i] : undefined;
    if (opts?.positiveDenominator && !(typeof denominator === 'number' && Number.isFinite(denominator) && denominator > 0)) { out.push(null); continue; }
    const args = keys.map((k) => series[k]?.[i]);
    if (!nullAsZero && args.some((v) => v === null || v === undefined || !Number.isFinite(v))) {
      out.push(null);
      continue;
    }
    const nums = args.map((v) =>
      v === null || v === undefined || !Number.isFinite(v) ? 0 : (v as number),
    );
    try {
      const v = fn(...nums);
      out.push(Number.isFinite(v) ? v : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

