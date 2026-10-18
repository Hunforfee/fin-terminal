import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const history = await load('searchHistory');
const personal = await load('personalStorage');
const values = new Map();
const originalWindow = globalThis.window;
test.before(() => {
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    dispatchEvent() {},
  };
  personal.setStorageAccount(null);
});
test.after(() => {
  globalThis.window = originalWindow;
});
test.beforeEach(() => values.clear());
const index = {
  code: '000001',
  name: '上证指数',
  market: 'SH',
  kind: 'index',
  board: '指数',
};
const stock = {
  code: '000001',
  name: '平安银行',
  market: 'SZ',
  kind: 'stock',
  board: '银行',
};
test('equal digits in different markets and asset kinds retain separate recent searches', () => {
  history.pushHistory(index);
  history.pushHistory(stock);
  assert.deepEqual(history.readHistory(), [stock, index]);
  history.pushHistory({ ...index, name: '上证指数更新' });
  assert.equal(history.readHistory().length, 2);
  assert.equal(history.readHistory()[0].name, '上证指数更新');
});
test('removing one search cannot delete another market with the same numeric code', () => {
  history.pushHistory(index);
  history.pushHistory(stock);
  history.removeHistory(stock.code, stock.market, stock.kind);
  assert.deepEqual(history.readHistory(), [index]);
});
test('old minimal entries and malformed metadata are normalized without crashing routing', () => {
  values.set(
    'ft.searchHistory.v1',
    JSON.stringify([
      { code: '600519', name: '贵州茅台', kind: 8, market: {}, board: null },
      null,
      { name: 'missing code' },
    ]),
  );
  assert.deepEqual(history.readHistory(), [
    { code: '600519', name: '贵州茅台', kind: 'stock', market: '', board: '' },
  ]);
});
