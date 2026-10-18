import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { xueqiuUrl, xueqiuSearchUrl } = await load('xueqiu');

test('A 股映射：沪深北三市都拼成 大写市场 + 6 位代码', () => {
  assert.equal(xueqiuUrl('sh600519', 'SH', 'stock'), 'https://xueqiu.com/S/SH600519');
  assert.equal(xueqiuUrl('sz000858', 'SZ', 'stock'), 'https://xueqiu.com/S/SZ000858');
  assert.equal(xueqiuUrl('sz300750', 'SZ', 'stock'), 'https://xueqiu.com/S/SZ300750');
  assert.equal(xueqiuUrl('bj430047', 'BJ', 'stock'), 'https://xueqiu.com/S/BJ430047');
});

test('港股映射：5 位代码不能补成 6 位，否则是死链', () => {
  assert.equal(xueqiuUrl('hk00700', 'HK', 'stock'), 'https://xueqiu.com/S/00700');
  assert.equal(xueqiuUrl('hk09988', 'HK', 'stock'), 'https://xueqiu.com/S/09988');
  assert.equal(xueqiuUrl('hk01810', 'HK', 'stock'), 'https://xueqiu.com/S/01810');
});

test('代码位数不足时左补零，位数超出则不猜', () => {
  assert.equal(xueqiuUrl('hk700', 'HK', 'stock'), 'https://xueqiu.com/S/00700');
  assert.equal(xueqiuUrl('sh519', 'SH', 'stock'), 'https://xueqiu.com/S/SH000519');
  assert.equal(xueqiuUrl('sh6005190', 'SH', 'stock'), null);
});

test('非个股没有雪球个股页：指数/基金/ETF 返回 null', () => {
  assert.equal(xueqiuUrl('sh000001', 'SH', 'index'), null);
  assert.equal(xueqiuUrl('sh510300', 'SH', 'etf'), null);
  assert.equal(xueqiuUrl('sz159915', 'SZ', 'fund'), null);
  // 未传 kind 时按个股处理（调用方已保证场景）
  assert.equal(xueqiuUrl('sh600519', 'SH'), 'https://xueqiu.com/S/SH600519');
});

test('美股/未知市场不生成链接，避免跳到错误页面', () => {
  assert.equal(xueqiuUrl('usaapl', 'US', 'stock'), null);
  assert.equal(xueqiuUrl('', 'SH', 'stock'), null);
  assert.equal(xueqiuUrl('sh', 'SH', 'stock'), null);
  assert.equal(xueqiuUrl('hk00700', '', 'stock'), null);
});

test('搜索兜底：中文名做 URL 编码', () => {
  assert.equal(
    xueqiuSearchUrl('贵州茅台'),
    `https://xueqiu.com/k?q=${encodeURIComponent('贵州茅台')}`,
  );
});
