import { normalizeStockCode } from './datasource/codes';

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export type ImportMarket = 'auto' | 'A' | 'HK';
export interface ImportRow {
  rawCode: string;
  name: string;
  symbol: string | null;
  reason: string | null;
  source: string;
  row: number;
}
export interface ImportTable {
  source: string;
  rows: unknown[][];
}
const text = (value: unknown) => (value == null ? '' : String(value).trim());
const heading = (value: unknown) =>
  text(value)
    .replace(/[\s\uFEFF]/g, '')
    .toLowerCase();
const codeHeading = (value: unknown) =>
  /^(?:(?:证券|股票|交易)?代码|证券编码|stockcode|securitycode|code)(?:[（(].*)?$/.test(
    heading(value),
  );
const nameHeading = (value: unknown) =>
  /^(?:(?:证券|股票)?(?:名称|简称)|name|stockname)$/.test(heading(value));
const marketHeading = (value: unknown) =>
  /^(?:市场|交易市场|交易所|上市地点|market|exchange)$/.test(heading(value));

function codeFromCell(
  value: unknown,
  name: string,
  market: string,
  preference: ImportMarket,
): { symbol: string | null; reason: string | null } {
  let code = text(value)
    .replace(/^=\s*"([^"]+)"$/, '$1')
    .replace(/^=(\d+)$/, '$1')
    .replace(/^['`]/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  code = code
    .replace(/^(shse|sse)[.:]?/, 'sh')
    .replace(/^(szse)[.:]?/, 'sz')
    .replace(/^hkex[.:]?/, 'hk')
    .replace(/^沪/, 'sh')
    .replace(/^深/, 'sz')
    .replace(/^[京北]/, 'bj')
    .replace(/^港/, 'hk')
    .replace(/^(sh|sz|bj|hk)[.:]/, '$1');
  if (!code) return { symbol: null, reason: '缺少股票代码' };
  if (/指数|ETF|LOF|基金/i.test(name))
    return { symbol: null, reason: '非股票标的' };
  const explicit = /^(?:sh|sz|bj|hk)\d+$|^\d+\.(?:sh|sz|bj|hk|ss)$/.test(code);
  if (!explicit) {
    if (!/^\d{1,6}$/.test(code))
      return { symbol: null, reason: '代码格式无法识别' };
    const hint = market.toLowerCase();
    const rowMarket = /港|hk|hongkong/.test(hint)
      ? 'HK'
      : /沪|上海|sh|sse/.test(hint)
        ? 'SH'
        : /深|深圳|sz/.test(hint)
          ? 'SZ'
          : /京|北京|bj|北交/.test(hint)
            ? 'BJ'
            : null;
    if (rowMarket === 'HK' || (!rowMarket && preference === 'HK')) {
      if (code.length > 5)
        return { symbol: null, reason: '港股代码应为 1—5 位' };
      code = 'hk' + code.padStart(5, '0');
    } else if (rowMarket || preference === 'A') {
      code = code.padStart(6, '0');
      if (rowMarket) code = rowMarket.toLowerCase() + code;
    } else if (code.length === 6) {
      // A-share stock context is essential for 000001 (Ping An Bank).
    } else if (typeof value !== 'number' && /^0\d{4}$/.test(code)) {
      code = 'hk' + code;
    } else {
      return { symbol: null, reason: '短代码缺少市场，请选择 A 股或港股' };
    }
  }
  const normalized = normalizeStockCode(code);
  if (!normalized) return { symbol: null, reason: '非股票代码或不支持的市场' };
  if (
    normalized.market !== 'HK' &&
    !/^(?:sh(?:60[0135]|68[89]|900)\d{3}|sz(?:00[0-3]|200|30[01])\d{3}|bj(?:[48]\d{5}|92\d{4}))$/.test(
      normalized.symbol,
    )
  ) {
    return { symbol: null, reason: '非股票代码或不支持的市场' };
  }
  return { symbol: normalized.symbol, reason: null };
}

export function parseImportTables(
  tables: ImportTable[],
  preference: ImportMarket = 'auto',
): ImportRow[] {
  const result: ImportRow[] = [];
  for (const table of tables) {
    const headerIndex = table.rows
      .slice(0, 50)
      .findIndex((row) => row.some(codeHeading));
    const headers = headerIndex >= 0 ? table.rows[headerIndex] : [];
    const codeIndex = headers.findIndex(codeHeading);
    const nameIndex = headers.findIndex(nameHeading);
    const marketIndex = headers.findIndex(marketHeading);
    table.rows.forEach((row, index) => {
      if (index <= headerIndex || !row.some((cell) => text(cell))) return;
      if (row.some(codeHeading)) return; // repeated printed headers
      if (/^(?:数据来源|导出时间|生成时间|合计|统计日期)/.test(text(row[0])))
        return;
      let code = codeIndex >= 0 ? row[codeIndex] : row[0];
      let name = nameIndex >= 0 ? text(row[nameIndex]) : '';
      if (codeIndex < 0) {
        // A simple code list may put several codes on one line. Do not scan
        // arbitrary financial columns or recover six digits from a price/date.
        if (
          row.length > 1 &&
          row.every((cell) =>
            /^(?:\d{6}|0\d{4}|(?:sh|sz|bj|hk)\d{4,6}|\d{4,6}\.(?:SH|SZ|BJ|HK))$/i.test(
              text(cell),
            ),
          )
        ) {
          for (const cell of row)
            result.push({
              rawCode: text(cell),
              name: '',
              ...codeFromCell(cell, '', '', preference),
              source: table.source,
              row: index + 1,
            });
          return;
        }
        if (
          /^\d{1,4}$/.test(text(code)) &&
          /^(?:\d{6}|0\d{4}|(?:sh|sz|bj|hk)\d{4,6})$/i.test(text(row[1])) &&
          /[^\d.%-]/.test(text(row[2]))
        ) {
          code = row[1];
          name = text(row[2]);
        } else name = text(row[1]);
      }
      const market = marketIndex >= 0 ? text(row[marketIndex]) : '';
      result.push({
        rawCode: text(code),
        name,
        ...codeFromCell(code, name, market, preference),
        source: table.source,
        row: index + 1,
      });
    });
  }
  if (result.length > MAX_IMPORT_ROWS)
    throw new Error(`一次最多导入 ${MAX_IMPORT_ROWS} 行，请拆分文件`);
  return result;
}

export function textImportTable(
  content: string,
  source = '粘贴内容',
): ImportTable {
  const clean = content.replace(/^\uFEFF/, '');
  const sample = clean.split(/\r?\n/).slice(0, 10).join('\n');
  const delimiter = sample.includes('\t')
    ? '\t'
    : sample.includes(',')
      ? ','
      : sample.includes(';')
        ? ';'
        : null;
  if (!delimiter)
    return {
      source,
      rows: clean.split(/\r\n|\n|\r/).map((line) => line.trim().split(/\s+/)),
    };
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === '"') {
      if (quoted && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || cell === '' || cell === '=') quoted = !quoted;
      else cell += char;
    } else if (!quoted && char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      row.push(cell);
      rows.push(row);
      cell = '';
      row = [];
      if (char === '\r' && clean[i + 1] === '\n') i++;
    } else cell += char;
  }
  if (quoted) throw new Error('文本引号未闭合，请检查导出文件');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { source, rows };
}

export function decodeImportText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0)
    return new TextDecoder('utf-16le').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

export async function readImportFile(file: {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<ImportTable[]> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`${file.name} 超过 5 MB`);
  if (!/\.(?:txt|csv|tsv|xls|xlsx)$/i.test(file.name))
    throw new Error('请选择 TXT、CSV、XLS 或 XLSX 文件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.(?:txt|csv|tsv)$/i.test(file.name))
    return [textImportTable(decodeImportText(bytes), file.name)];
  const binary =
    (bytes[0] === 0x50 && bytes[1] === 0x4b) ||
    (bytes[0] === 0xd0 && bytes[1] === 0xcf);
  const decoded = binary ? null : decodeImportText(bytes);
  if (!binary && /\.xlsx$/i.test(file.name))
    throw new Error(`${file.name} 不是有效的 Excel 文件`);
  if (decoded && !/^\s*</.test(decoded))
    return [textImportTable(decoded, file.name)];
  const XLSX = await import('xlsx');
  XLSX.set_cptable(await import('xlsx/dist/cpexcel.full.mjs'));
  let workbook;
  try {
    workbook = XLSX.read(decoded ?? bytes, {
      type: decoded === null ? 'array' : 'string',
      raw: decoded !== null,
      codepage: 936,
      sheetRows: MAX_IMPORT_ROWS + 51,
      cellText: true,
    });
  } catch {
    throw new Error(`${file.name} 无法读取，请使用未加密的导出表格`);
  }
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = XLSX.utils.decode_range(
      sheet['!fullref'] ?? sheet['!ref'] ?? 'A1',
    );
    if (range.e.r >= MAX_IMPORT_ROWS + 50)
      throw new Error(`一次最多导入 ${MAX_IMPORT_ROWS} 行，请拆分文件`);
    // formatted text retains codes stored with Excel's 000000 display format;
    // unformatted numeric short codes remain numbers and require a market choice.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: '',
    });
    rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        const original =
          sheet[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })];
        if (
          typeof cell === 'number' &&
          original?.w &&
          /^0\d{4,5}$/.test(original.w)
        )
          row[c] = original.w;
      }),
    );
    return { source: `${file.name} · ${name}`, rows };
  });
}

export function uniqueImportRows(rows: ImportRow[]): {
  candidates: ImportRow[];
  rejected: ImportRow[];
  duplicates: number;
} {
  const seen = new Set<string>();
  let duplicates = 0;
  const candidates: ImportRow[] = [],
    rejected: ImportRow[] = [];
  for (const row of rows) {
    if (!row.symbol) {
      rejected.push(row);
      continue;
    }
    if (seen.has(row.symbol)) {
      duplicates++;
      continue;
    }
    seen.add(row.symbol);
    candidates.push(row);
  }
  return { candidates, rejected, duplicates };
}
