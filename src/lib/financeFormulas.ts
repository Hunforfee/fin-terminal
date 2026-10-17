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
}

/**
 * 内置预设公式（已用茅台真实数据核对）：
 * - 资产负债率 2024 = 19.04%，与新浪指标页披露值完全一致
 * - 有息负债率 = (短期借款 + 一年内到期的非流动负债 + 长期借款 + 应付债券 + 租赁负债) / 资产总计
 * - 现金/有息债 = (货币资金 + 交易性金融资产) / 有息负债；无有息负债时该期无意义 → 空点
 * - 利息保障倍数 = (利润总额 + 财务费用) / 财务费用 = EBIT / 利息费用。
 *   我国利润表不单列「利息费用」，实务上以利润表「财务费用」代替（pl_财务费用）。
 *   已用茅台 2025 四个报告期与新浪指标页披露的「利息支付倍数」逐期对账，完全一致：
 *     2025-12-31 → -139.7625（新浪 -13976.2501/100）
 *     2025-09-30 → -139.8526（新浪 -13985.2619/100）
 *     2025-06-30 → -128.0017（新浪 -12800.1722/100）
 *     2025-03-31 → -130.0618（新浪 -13006.1810/100）
 *   注意：分母必须是利润表口径 pl_财务费用，不能用现金流量表附注的 cf_财务费用
 *   （后者只是间接法下「属于筹资/投资活动的财务费用」加回项，茅台 2025 仅 2873.49 万，
 *    用它算会得出 3994 倍的错误结果）。
 *   另：当公司无有息负债、财务费用为净利息收入（为负）时，该指标本身无意义，
 *   会呈现负值——这与新浪等数据源的披露口径一致，属口径特性而非计算错误。
 */
export const PRESET_FORMULAS: Formula[] = [
  {
    id: 'p-debt-ratio',
    name: '资产负债率（自算）',
    expr: 'bs_负债合计 / bs_资产总计 * 100',
    unit: 'pct',
    preset: true,
    nullAsZero: true,
  },
  {
    id: 'p-interest-debt-ratio',
    name: '有息负债率（自算）',
    expr:
      '(bs_短期借款 + bs_一年内到期的非流动负债 + bs_长期借款 + bs_应付债券 + bs_租赁负债) / bs_资产总计 * 100',
    unit: 'pct',
    preset: true,
    nullAsZero: true,
  },
  {
    id: 'p-cash-to-debt',
    name: '现金/有息债（自算）',
    expr:
      '(bs_货币资金 + bs_交易性金融资产) / (bs_短期借款 + bs_一年内到期的非流动负债 + bs_长期借款 + bs_应付债券 + bs_租赁负债)',
    unit: '',
    preset: true,
    nullAsZero: true,
  },
  {
    id: 'p-interest-coverage',
    name: '利息保障倍数（自算）',
    // 利润总额 = 归母净利 + 少数股东损益 + 所得税费用；EBIT = 利润总额 + 财务费用
    expr:
      '(pl_归属于母公司所有者的净利润 + pl_少数股东损益 + pl_减：所得税费用 + pl_财务费用) / pl_财务费用',
    unit: '',
    preset: true,
    nullAsZero: true,
  },
  // ---- 以下 5 条为扩展主流指标（周转率用期末值口径，非平均余额口径） ----
  {
    id: 'p-gross-margin',
    name: '毛利率（自算）',
    expr: '(pl_营业收入 - pl_营业成本) / pl_营业收入 * 100',
    unit: 'pct',
    preset: true,
  },
  {
    id: 'p-inventory-turnover',
    name: '存货周转率（自算）',
    expr: 'pl_营业成本 / bs_存货',
    unit: '',
    preset: true,
  },
  {
    id: 'p-receivable-turnover',
    name: '应收账款周转率（自算）',
    expr: 'pl_营业收入 / bs_应收账款',
    unit: '',
    preset: true,
  },
  {
    id: 'p-fcf',
    name: '自由现金流（自算）',
    expr:
      'cf_经营活动产生的现金流量净额 - cf_购建固定资产、无形资产和其他长期资产所支付的现金',
    unit: 'wan',
    preset: true,
    nullAsZero: true,
  },
  {
    id: 'p-equity-multiplier',
    name: '权益乘数（自算）',
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
    const raw = localStorage.getItem(LS_KEY);
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
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const LS_HIDDEN_PRESETS = 'fin.financeFormulas.hiddenPresets';

/** 合并预设 + 用户公式（用户删除的预设记入隐藏列表） */
export function mergedFormulas(): Formula[] {
  let hidden: string[] = [];
  try {
    hidden = JSON.parse(localStorage.getItem(LS_HIDDEN_PRESETS) ?? '[]');
  } catch {
    /* ignore */
  }
  const user = loadFormulas().filter((f) => !f.preset);
  return [...PRESET_FORMULAS.filter((p) => !hidden.includes(p.id)), ...user];
}

export function hidePreset(id: string): void {
  try {
    const hidden: string[] = JSON.parse(localStorage.getItem(LS_HIDDEN_PRESETS) ?? '[]');
    if (!hidden.includes(id)) hidden.push(id);
    localStorage.setItem(LS_HIDDEN_PRESETS, JSON.stringify(hidden));
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
  opts?: { nullAsZero?: boolean },
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
