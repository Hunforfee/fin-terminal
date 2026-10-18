import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const { renderNote } = await load('noteMarkdown');

test('plain text keeps line breaks and escapes HTML', () => {
  const html = renderNote('第一行\n第二行 <script>alert(1)</script>');
  assert.match(html, /第一行<br \/>第二行/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('bold, italic, inline code and links render safely', () => {
  const html = renderNote('**营收** *增长* `code` [东财](https://eastmoney.com/a?b=1)');
  assert.match(html, /<strong>营收<\/strong>/);
  assert.match(html, /<em>增长<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /href="https:\/\/eastmoney.com\/a\?b=1"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('javascript: links are not turned into anchors', () => {
  const html = renderNote('[点我](javascript:alert(1))');
  assert.ok(!/<a[^>]*javascript/.test(html));
});

test('markdown table becomes a real table with alignment', () => {
  const html = renderNote(
    '| 指标 | 2024 | 2025 |\n| --- | ---: | :---: |\n| 营收 | 100 | 120 |\n| 净利 | 20 | 25 |',
  );
  assert.match(html, /<table>/);
  assert.match(html, /<th>指标<\/th>/);
  assert.match(html, /style="text-align:right"/);
  assert.match(html, /style="text-align:center"/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  assert.match(html, /<div class="md-table">/);
});

test('unordered, ordered and nested lists render', () => {
  const html = renderNote('- 一\n- 二\n  - 二点一\n1. 甲\n2. 乙');
  assert.match(html, /<ul><li>一<\/li><li>二<ul><li>二点一<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
});

test('task list items render checkbox state', () => {
  const html = renderNote('- [x] 已读年报\n- [ ] 访谈董秘');
  assert.match(html, /<input type="checkbox" disabled checked \/>/);
  assert.match(html, /<input type="checkbox" disabled \/>/);
});

test('code fence keeps content verbatim and escapes it', () => {
  const html = renderNote('```ts\nconst a = 1 < 2;\n```');
  assert.match(html, /<pre><code data-lang="ts">const a = 1 &lt; 2;<\/code><\/pre>/);
});

test('headings, quote and horizontal rule', () => {
  const html = renderNote('## 结论\n> 估值偏低\n---');
  assert.match(html, /<h4>结论<\/h4>/);
  assert.match(html, /<blockquote>估值偏低<\/blockquote>/);
  assert.match(html, /<hr \/>/);
});

test('empty input renders empty string', () => {
  assert.equal(renderNote(''), '');
});
