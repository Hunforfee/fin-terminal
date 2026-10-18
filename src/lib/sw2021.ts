/**
 * 申万行业分类（2021 版）三级树 + 成分股。
 *
 * 数据文件 `sw2021.json` 为构建期生成的静态快照（分类结构变化极慢）：
 *   - 一级 31 个 / 二级 131 个 / 三级 335 个（申万 2021 官方口径）
 *   - 每级都带完整成分股代码列表，合计去重 5659 只 A 股
 * 分类层级与名称来自申万 2021 标准；成分股归属按东方财富 F10 行业板块（rank1/2/3 对应申万三档）映射。
 *
 * 已知缺口：申万二级「国有大型银行Ⅱ / 股份制银行Ⅱ / 城商行Ⅱ / 农商行Ⅱ」在数据源侧与「银行Ⅱ」合并，
 * 无独立成分股，故这 4 个二级节点的成分股为空（前端会提示），但一级「银行」完整。
 */

import raw from './sw2021.json' with { type: 'json' };

export interface SwNode {
  /** 行业名称，如「白酒Ⅱ」 */
  name: string;
  /** 行业代码（申万代码或名称键） */
  code: string;
  /** 成分股数量 */
  count: number;
  /** 成分股代码（6 位） */
  stocks: string[];
  children?: SwNode[];
}

export interface SwTree {
  version: string;
  industries: SwNode[];
}

export const SW2021 = raw as SwTree;

/** 扁平化后的全部节点（用于按名查找） */
export interface SwFlatNode extends SwNode {
  level: 1 | 2 | 3;
  /** 一级行业名 */
  l1: string;
  /** 二级行业名（level>=2） */
  l2?: string;
}

let flatCache: SwFlatNode[] | null = null;

export function swAllNodes(): SwFlatNode[] {
  if (flatCache) return flatCache;
  const out: SwFlatNode[] = [];
  for (const i1 of SW2021.industries) {
    out.push({ ...i1, children: undefined, level: 1, l1: i1.name });
    for (const i2 of i1.children ?? []) {
      out.push({ ...i2, children: undefined, level: 2, l1: i1.name, l2: i2.name });
      for (const i3 of i2.children ?? []) {
        out.push({ ...i3, children: undefined, level: 3, l1: i1.name, l2: i2.name });
      }
    }
  }
  flatCache = out;
  return out;
}

/** 按名称查找行业节点（重名时优先层级高的） */
export function findSwNode(name: string, level?: 1 | 2 | 3): SwFlatNode | null {
  const all = swAllNodes();
  const hits = all.filter((n) => n.name === name && (level === undefined || n.level === level));
  return hits[0] ?? null;
}

/** 统计概览 */
export function swStats() {
  const all = swAllNodes();
  const codes = new Set<string>();
  for (const n of all) for (const c of n.stocks) codes.add(c);
  return {
    l1: all.filter((n) => n.level === 1).length,
    l2: all.filter((n) => n.level === 2).length,
    l3: all.filter((n) => n.level === 3).length,
    stocks: codes.size,
  };
}
