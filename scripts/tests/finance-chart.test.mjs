import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const { alignFinancialComparison } = await load('financeChart');

test('comparison starts later and missing report periods leave gaps at the correct dates', () => {
  const primary = {
    periods: ['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31'],
    periodLabels: ['2022', '2023', '2024', '2025'],
  };
  const comparison = {
    periods: ['2023-12-31', '2025-12-31'],
    periodLabels: ['2023', '2025'],
    values: [13, 0],
  };
  const before = structuredClone({ primary, comparison });
  assert.deepEqual(alignFinancialComparison(primary, comparison), [
    null,
    13,
    null,
    0,
  ]);
  assert.deepEqual({ primary, comparison }, before);
});

test('matching display years do not align different fiscal report dates', () => {
  assert.deepEqual(
    alignFinancialComparison(
      { periods: ['2024-12-31', '2025-12-31'], periodLabels: ['2024', '2025'] },
      {
        periods: ['2024-03-31', '2025-03-31'],
        periodLabels: ['2024', '2025'],
        values: [4, 5],
      },
    ),
    [null, null],
  );
});

test('null, non-finite and absent comparison values remain missing, zero stays zero', () => {
  const axis = {
    periods: ['a', 'b', 'c', 'd', 'e'],
    periodLabels: ['a', 'b', 'c', 'd', 'e'],
  };
  assert.deepEqual(
    alignFinancialComparison(axis, {
      ...axis,
      values: [0, null, NaN, Infinity],
    }),
    [0, null, null, null, null],
  );
});

test('legacy series without date arrays align by exact labels, never by index', () => {
  assert.deepEqual(
    alignFinancialComparison(
      { periodLabels: ['2023Q1', '2023H1', '2023Q3'] },
      { periodLabels: ['2023H1', '2023Q3'], values: [2, 3] },
    ),
    [null, 2, 3],
  );
});

test('partial date metadata cannot silently fall back to ambiguous display labels', () => {
  assert.deepEqual(
    alignFinancialComparison(
      { periods: ['2024-12-31'], periodLabels: ['2024'] },
      { periodLabels: ['2024'], values: [4] },
    ),
    [null],
  );
  assert.deepEqual(
    alignFinancialComparison(
      { periods: ['2023-12-31'], periodLabels: ['2023', '2024'] },
      { periods: ['2024-12-31'], periodLabels: ['2024'], values: [4] },
    ),
    [null, null],
  );
});
