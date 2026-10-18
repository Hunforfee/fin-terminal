/** Hong Kong directory snapshot. The hierarchy is Eastmoney F10's own taxonomy. */
import raw from './hk-industries.json' with { type: 'json' };

export interface HkIndustryMember {
  code: string;
  name: string;
  /** Real source levels only; absent classification remains unclassified. */
  industryPath: string[];
  industryDetail: string | null;
  /** A separate, single-level F10 classification, retained for provenance. */
  industry: string | null;
  listingDate: string | null;
  board: string | null;
}
export interface HkIndustryNode {
  name: string;
  code: string;
  count: number;
  stocks: string[];
  children?: HkIndustryNode[];
}
export interface HkIndustryFlatNode extends HkIndustryNode {
  level: 1 | 2 | 3;
  l1: string;
  l2?: string;
}
export const HK_INDUSTRIES = raw;
export const HK_INDUSTRY_MEMBERS = raw.members as HkIndustryMember[];
export const hkIndustrySymbol = (code: string): string | null =>
  /^\d{5}$/.test(code) && Number(code) > 0 && Number(code) < 80000 ? `hk${code}` : null;

const byCode = new Map(HK_INDUSTRY_MEMBERS.map((member) => [member.code, member]));
const industries: HkIndustryNode[] = [];
for (const member of HK_INDUSTRY_MEMBERS) {
  const path = member.industryPath.length ? member.industryPath.slice(0, 3) : ['未分类'];
  let siblings = industries;
  for (let index = 0; index < path.length; index++) {
    const name = path[index];
    let node = siblings.find((candidate) => candidate.name === name);
    if (!node) {
      node = { name, code: JSON.stringify(path.slice(0, index + 1)), count: 0, stocks: [] };
      siblings.push(node);
    }
    node.stocks.push(member.code);
    node.count++;
    if (index < path.length - 1) siblings = node.children ??= [];
  }
}
function sortNodes(nodes: HkIndustryNode[]): void {
  nodes.sort((a, b) => a.name === '未分类' ? 1 : b.name === '未分类' ? -1 :
    a.name.localeCompare(b.name, 'zh-CN'));
  for (const node of nodes) if (node.children) sortNodes(node.children);
}
sortNodes(industries);

export function hkIndustryTree(): HkIndustryNode[] { return industries; }
const flat: HkIndustryFlatNode[] = [];
for (const first of industries) {
  flat.push({ ...first, children: undefined, level: 1, l1: first.name });
  for (const second of first.children ?? []) {
    flat.push({ ...second, children: undefined, level: 2, l1: first.name, l2: second.name });
    for (const third of second.children ?? [])
      flat.push({ ...third, children: undefined, level: 3, l1: first.name, l2: second.name });
  }
}
export function hkAllNodes(): HkIndustryFlatNode[] { return flat; }
export function hkStats() {
  return {
    l1: industries.length,
    l2: flat.filter((node) => node.level === 2).length,
    l3: flat.filter((node) => node.level === 3).length,
    stocks: HK_INDUSTRY_MEMBERS.length,
  };
}
export function hkIndustryMember(code: string): HkIndustryMember | undefined {
  return byCode.get(code);
}
export function findHkIndustryNode(
  name: string, level?: 1 | 2 | 3, l1?: string | null, l2?: string | null,
): HkIndustryFlatNode | null {
  const matches = flat.filter((node) => node.name === name &&
    (level === undefined || node.level === level) && (!l1 || node.l1 === l1) &&
    (!l2 || node.l2 === l2));
  return matches.length === 1 ? matches[0] : null;
}

/** Resolve the separate profile label only when all its members share a real node. */
export function resolveHkIndustry(industry: string): HkIndustryFlatNode | null {
  const members = HK_INDUSTRY_MEMBERS.filter((member) => member.industry === industry);
  if (!members.length || members.some((member) => !member.industryPath.length)) return null;
  const common = members[0].industryPath.slice(0, 3);
  for (const member of members)
    while (common.length && common.some((name, index) => member.industryPath[index] !== name))
      common.pop();
  if (!common.length) return null;
  return findHkIndustryNode(common[common.length - 1], common.length as 1 | 2 | 3,
    common[0], common[1]);
}
