import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const {
  SCREEN_PREFERENCES_KEY,
  SCREEN_SCHEMES_KEY,
  SCREEN_COLUMNS,
  DEFAULT_SCREEN_COLUMNS,
  emptyScreenerDraft,
  readScreenerPreferences,
  readScreenerSchemes,
} = await load('screenerPreferences');
const {
  isCloudKey,
  validateSnapshot,
  personalStorage,
  setStorageAccount,
  snapshotFor,
  applySnapshot,
  PERSONAL_CHANGE,
} = await load('personalStorage');
const period = '2026-06-30';
const scheme = (changes = {}) => ({
  id: 'test-scheme',
  name: '质量与估值',
  criteria: emptyScreenerDraft(period),
  columns: [...DEFAULT_SCREEN_COLUMNS],
  sort: { key: 'roe', direction: 'desc' },
  ...changes,
});

test('empty draft, typed column catalog and default preferences have stable independent values', () => {
  const first = emptyScreenerDraft(period),
    second = emptyScreenerDraft(period);
  assert.equal(first.scope, 'all');
  assert.equal(first.period, period);
  assert.equal(first.cashflowPositive, false);
  assert.equal(first.deductedProfitPositive, false);
  assert.ok(
    Object.entries(first)
      .filter(
        ([key]) =>
          ![
            'scope',
            'period',
            'cashflowPositive',
            'deductedProfitPositive',
          ].includes(key),
      )
      .every(([, value]) => value === ''),
  );
  first.peMin = '15';
  assert.equal(second.peMin, '');
  assert.equal(SCREEN_COLUMNS.length, 13);
  assert.equal(new Set(SCREEN_COLUMNS.map((column) => column.id)).size, 13);
  assert.deepEqual(readScreenerPreferences(null), {
    columns: DEFAULT_SCREEN_COLUMNS,
    sort: { key: 'totalMarketCap', direction: 'desc' },
    filtersCollapsed: false,
  });
  const a = readScreenerPreferences(null),
    b = readScreenerPreferences(null);
  a.columns.pop();
  a.sort.key = 'name';
  assert.deepEqual(b.columns, DEFAULT_SCREEN_COLUMNS);
  assert.equal(b.sort.key, 'totalMarketCap');
});

test('preference columns retain order and explicit empty selections, and hidden sorts use visible defaults', () => {
  assert.deepEqual(
    readScreenerPreferences({
      columns: ['pb', 'roe', 'pb', 'not-a-column'],
      sort: { key: 'pe', direction: 'asc' },
      filtersCollapsed: true,
    }),
    {
      columns: ['pb', 'roe'],
      sort: { key: 'roe', direction: 'desc' },
      filtersCollapsed: true,
    },
  );
  assert.deepEqual(
    readScreenerPreferences({
      columns: [],
      sort: { key: 'roe', direction: 'desc' },
      filtersCollapsed: 'true',
    }),
    {
      columns: [],
      sort: { key: 'name', direction: 'asc' },
      filtersCollapsed: false,
    },
  );
  assert.deepEqual(
    readScreenerPreferences({
      columns: ['pb', 'pe'],
      sort: { key: 'pb', direction: 'asc' },
    }).sort,
    { key: 'pb', direction: 'asc' },
  );
  for (const key of ['name', 'industry'])
    assert.deepEqual(
      readScreenerPreferences({ columns: [], sort: { key, direction: 'desc' } })
        .sort,
      { key, direction: 'desc' },
    );
  assert.deepEqual(
    readScreenerPreferences({
      columns: ['pb'],
      sort: { key: 'pb', direction: 'invalid' },
    }).sort,
    { key: 'name', direction: 'asc' },
  );
});

test('schemes preserve finite numeric drafts including negative/zero/empty and resolve group membership later', () => {
  const incoming = scheme({
    criteria: {
      ...emptyScreenerDraft(period),
      scope: 'group:任意 id/中文:?=1',
      industry: '  食品饮料  ',
      peMin: ' -5 ',
      peMax: '0',
      pbMin: '-0',
      pbMax: '.75',
      roeMin: '1e1',
      cashflowPositive: true,
      deductedProfitPositive: true,
      codes: ['sh600519'],
      stocks: ['hk00700'],
    },
    extraApiKey: 'must-not-survive',
  });
  const [read] = readScreenerSchemes([incoming], period);
  assert.equal(read.criteria.scope, incoming.criteria.scope);
  assert.equal(read.criteria.industry, '食品饮料');
  assert.equal(read.criteria.peMin, '-5');
  assert.equal(read.criteria.peMax, '0');
  assert.equal(read.criteria.pbMin, '-0');
  assert.equal(read.criteria.pbMax, '.75');
  assert.equal(read.criteria.roeMin, '1e1');
  assert.equal(read.criteria.ocfMin, '');
  assert.equal(read.criteria.cashflowPositive, true);
  assert.ok(!('codes' in read.criteria));
  assert.ok(!('stocks' in read.criteria));
  assert.ok(!('extraApiKey' in read));
  assert.deepEqual(
    readScreenerSchemes(JSON.parse(JSON.stringify([read])), period),
    [read],
  );
});

test('malformed, incomplete and nonfinite schemes are rejected without corrupting valid neighbors', () => {
  const invalid = [
    null,
    [],
    {},
    'text',
    false,
    1,
    scheme({ id: '' }),
    scheme({ name: '  ' }),
    scheme({ columns: null }),
    scheme({ sort: null }),
    scheme({ sort: { key: 'unknown', direction: 'asc' } }),
    scheme({ sort: { key: 'roe', direction: 'up' } }),
    scheme({ criteria: {} }),
    scheme({ criteria: { ...emptyScreenerDraft(period), roeMin: null } }),
    ...[
      'NaN',
      'Infinity',
      '-Infinity',
      '1e9999',
      '0x10',
      '1,000',
      '1+2',
      '--1',
    ].map((peMin) =>
      scheme({ criteria: { ...emptyScreenerDraft(period), peMin } }),
    ),
    scheme({ criteria: { ...emptyScreenerDraft(period), scope: 'group:' } }),
    scheme({ criteria: { ...emptyScreenerDraft(period), scope: 'all\n' } }),
    scheme({
      criteria: { ...emptyScreenerDraft(period), cashflowPositive: 'true' },
    }),
    scheme({
      criteria: { ...emptyScreenerDraft(period), period: '2026-02-30' },
    }),
    scheme({
      criteria: { ...emptyScreenerDraft(period), period: '2026-6-30' },
    }),
    JSON.parse('{"__proto__":{"polluted":true}}'),
    scheme({
      criteria: JSON.parse(
        JSON.stringify({
          ...emptyScreenerDraft(period),
          constructor: { prototype: { polluted: true } },
        }),
      ),
    }),
  ];
  assert.deepEqual(
    readScreenerSchemes([...invalid, scheme({ id: 'safe' })], period).map(
      (value) => value.id,
    ),
    ['safe'],
  );
  for (const raw of [null, {}, false, 0, '', new Date(), Symbol('invalid')]) {
    assert.deepEqual(readScreenerSchemes(raw, period), []);
    assert.doesNotThrow(() => readScreenerPreferences(raw));
  }
  assert.equal({}.polluted, undefined);
});

test('schemes trim ids/names, cap names at 24 Unicode characters, deduplicate and retain only 12 valid schemes', () => {
  const values = [
    scheme({ id: '  same  ', name: `  ${'股😀'.repeat(20)}  ` }),
    scheme({ id: 'same', name: 'duplicate' }),
    ...Array.from({ length: 20 }, (_, index) =>
      scheme({ id: `other-${index}` }),
    ),
  ];
  const read = readScreenerSchemes(values, period);
  assert.equal(read.length, 12);
  assert.equal(read[0].id, 'same');
  assert.equal([...read[0].name].length, 24);
  assert.equal(read.filter((value) => value.id === 'same').length, 1);
  assert.equal(read.at(-1).id, 'other-10');
  const missingPeriod = { ...emptyScreenerDraft(period) };
  delete missingPeriod.period;
  assert.equal(
    readScreenerSchemes([scheme({ criteria: missingPeriod })], '2024-02-29')[0]
      .criteria.period,
    '2024-02-29',
  );
  assert.deepEqual(
    readScreenerSchemes([scheme({ criteria: missingPeriod })], '2025-02-29'),
    [],
  );
  assert.deepEqual(
    readScreenerSchemes(
      [scheme({ columns: [], sort: { key: 'roe', direction: 'desc' } })],
      period,
    )[0].sort,
    { key: 'name', direction: 'asc' },
  );
});

test('screener preferences and schemes use the existing isolated account JSON synchronization path', () => {
  const previous = globalThis.window;
  const store = new Map(),
    events = [];
  globalThis.window = {
    localStorage: {
      get length() {
        return store.size;
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
    dispatchEvent: (event) => {
      events.push(event.type);
      return true;
    },
  };
  try {
    for (const key of [SCREEN_PREFERENCES_KEY, SCREEN_SCHEMES_KEY])
      assert.ok(isCloudKey(key));
    assert.equal(isCloudKey(`${SCREEN_SCHEMES_KEY}.apiKey`), false);
    const preferences = JSON.stringify(readScreenerPreferences(null)),
      schemes = JSON.stringify([scheme()]);
    setStorageAccount('screener-fixture-a');
    personalStorage.setItem(SCREEN_PREFERENCES_KEY, preferences);
    personalStorage.setItem(SCREEN_SCHEMES_KEY, schemes);
    assert.deepEqual(snapshotFor('screener-fixture-a'), {
      [SCREEN_PREFERENCES_KEY]: preferences,
      [SCREEN_SCHEMES_KEY]: schemes,
    });
    assert.ok(validateSnapshot(snapshotFor('screener-fixture-a')));
    assert.equal(
      validateSnapshot({ [SCREEN_SCHEMES_KEY]: 'broken json' }),
      null,
    );
    setStorageAccount('screener-fixture-b');
    assert.equal(personalStorage.getItem(SCREEN_SCHEMES_KEY), null);
    assert.deepEqual(snapshotFor('screener-fixture-b'), {});
    applySnapshot('screener-fixture-b', { [SCREEN_SCHEMES_KEY]: schemes });
    assert.equal(personalStorage.getItem(SCREEN_SCHEMES_KEY), schemes);
    assert.equal(events.length, 2);
    assert.ok(events.every((value) => value === PERSONAL_CHANGE));
    assert.deepEqual(snapshotFor(null), {});
  } finally {
    globalThis.window = previous;
    setStorageAccount(null);
  }
});
