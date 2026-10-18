/**
 * 笔记正文 → HTML：轻量 Markdown 子集（无第三方依赖，纯函数便于测试）。
 *
 * 支持：标题、无序/有序列表（含嵌套缩进）、任务列表、表格、围栏代码块、
 * 引用、水平线、行内代码、粗体/斜体/删除线、链接、自动链接；
 * 非上述结构的文本按原样保留换行，因此纯文本笔记也不会走样。
 *
 * 安全：先做 HTML 实体转义再套格式，链接仅放行 http(s)/mailto，杜绝注入。
 */

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 行内格式：代码 > 粗体 > 斜体 > 删除线 > 链接 */
function inline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>',
    )
    .replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$2</a>',
    );
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[+i]}</code>`);
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isDelimiterRow = (line: string) =>
  /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line) && line.includes('-');

const ALIGN: Record<string, string> = {
  ':-:': 'center',
  '-:': 'right',
  ':--': 'left',
};

function alignOf(cell: string): string {
  const c = cell.replace(/\s/g, '');
  if (c.startsWith(':') && c.endsWith(':')) return ALIGN[':-:'];
  if (c.endsWith(':')) return ALIGN['-:'];
  return '';
}

/** 把收集到的列表项按缩进还原成嵌套 <ul>/<ol>，支持 [ ] / [x] 任务框 */
function renderList(
  items: { indent: number; ordered: boolean; text: string }[],
): string {
  let index = 0;
  const itemHtml = (text: string) => {
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
    if (!task) return inline(text);
    const checked = task[1].toLowerCase() === 'x';
    return `<label><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${inline(task[2])}</label>`;
  };
  const build = (indent: number): string => {
    const tag = items[index].ordered ? 'ol' : 'ul';
    let out = `<${tag}>`;
    while (index < items.length && items[index].indent >= indent) {
      if (items[index].indent > indent) {
        out = out.replace(/<\/li>$/, '') + build(items[index].indent) + '</li>';
        continue;
      }
      const text = items[index].text;
      index++;
      const nested = index < items.length && items[index].indent > indent;
      out += `<li>${itemHtml(text)}${nested ? build(items[index].indent) : ''}</li>`;
    }
    return out + `</${tag}>`;
  };
  const base = Math.min(...items.map((item) => item.indent));
  return build(base);
}

export function renderNote(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(
      `<p>${paragraph.map(inline).join('<br />')}</p>`,
    );
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    /* 围栏代码块 */
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const lang = fence[2].trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        code.push(lines[i]);
        i++;
      }
      i++;
      html.push(
        `<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`,
      );
      continue;
    }

    /* 表格：当前行含 | 且下一行是分隔行 */
    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      flushParagraph();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header
        .map(
          (cell, index) =>
            `<th${aligns[index] && alignOf(aligns[index]) ? ` style="text-align:${alignOf(aligns[index])}"` : ''}>${inline(cell)}</th>`,
        )
        .join('');
      const tbody = rows
        .map(
          (row) =>
            `<tr>${header
              .map(
                (_h, index) =>
                  `<td${aligns[index] && alignOf(aligns[index]) ? ` style="text-align:${alignOf(aligns[index])}"` : ''}>${inline(row[index] ?? '')}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('');
      html.push(
        `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    /* 水平线 */
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      html.push('<hr />');
      i++;
      continue;
    }

    /* 标题 */
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    /* 引用 */
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${quote.map(inline).join('<br />')}</blockquote>`);
      continue;
    }

    /* 列表（含缩进层级与任务框） */
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      const items: { indent: number; ordered: boolean; text: string }[] = [];
      let blockIndent: number | null = null;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const indent = m[1].replace(/\t/g, '  ').length;
        const ordered = /\d/.test(m[2]);
        // 同级换列表类型（- 与 1.）说明是新的列表块，不能并入同一个 <ul>/<ol>
        if (blockIndent === null) blockIndent = indent;
        else if (indent === blockIndent && ordered !== items[0].ordered) break;
        items.push({ indent, ordered, text: m[3] });
        i++;
      }
      html.push(renderList(items));
      continue;
    }

    /* 空行结束段落 */
    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return html.join('\n');
}
