import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const {
  RESEARCH_NOTES_KEY,
  RESEARCH_NOTE_DRAFT_KEY,
  DAILY_NOTE_DRAFT_KEY,
  parseResearchNotes,
  readResearchNotes,
  researchNoteSymbol,
  researchNoteKind,
  todayResearchDate,
  isResearchDate,
  saveResearchNote,
  removeResearchNote,
} = await load('researchNotes');
const { isCloudKey, storageKey, validateSnapshot } =
  await load('personalStorage');
const old = {
  id: 'old',
  code: '600415',
  name: '小商品城',
  text: '旧研究记录',
  date: '2026/10/17',
};
const input = { code: '00700', name: '腾讯控股', text: '  新研究记录  ' };
const now = new Date('2026-10-17T17:00:00Z');
const memory = (initial = [old]) => {
  let raw = JSON.stringify(initial);
  return {
    read: () => raw,
    write: (value) => {
      raw = value;
    },
  };
};

test('old notes retain IDs, text, dates, metadata and stock routes without migration', () => {
  const legacy = { ...old, extra: 'preserved' };
  assert.deepEqual(parseResearchNotes([legacy]), [legacy]);
  assert.deepEqual(readResearchNotes(JSON.stringify([legacy])), [legacy]);
  assert.equal(researchNoteSymbol({ code: '000001' }), 'sz000001');
  assert.equal(researchNoteSymbol({ code: '00700' }), 'hk00700');
  assert.equal(
    researchNoteSymbol({ code: '000001', symbol: 'sz000001' }),
    'sz000001',
  );
  assert.equal(
    researchNoteSymbol({ code: '600415', symbol: 'sh600415' }),
    'sh600415',
  );
  assert.equal(researchNoteSymbol({ code: 'not-a-stock' }), '');
});

test('new note uses Shanghai date, trimmed text and canonical stock symbol', () => {
  const store = memory();
  const { note, notes } = saveResearchNote(store, input, undefined, {
    now,
    createId: () => 'new',
  });
  assert.equal(note.id, 'new');
  assert.equal(note.date, '2026/10/18');
  assert.equal(note.updatedAt, now.toISOString());
  assert.equal(note.text, '新研究记录');
  assert.equal(note.symbol, 'hk00700');
  assert.deepEqual(
    notes.map((n) => n.id),
    ['new', 'old'],
  );
  assert.deepEqual(JSON.parse(store.read()), notes);
});

test('daily entries need no stock, default to the Shanghai day and allow multiple separate entries on one day', () => {
  const store = memory();
  const first = saveResearchNote(
    store,
    { kind: 'daily', text: '  今日心得\n  ' },
    undefined,
    { now, createId: () => 'daily-a' },
  ).note;
  assert.equal(first.kind, 'daily');
  assert.equal(first.entryDate, '2026-10-18');
  assert.equal(first.text, '今日心得');
  assert.equal(first.code, '');
  assert.equal(first.name, '');
  assert.equal(Object.hasOwn(first, 'symbol'), false);
  assert.equal(researchNoteSymbol(first), '');
  const second = saveResearchNote(
    store,
    {
      kind: 'daily',
      entryDate: first.entryDate,
      text: '另一个独立想法',
      code: '600415',
      name: '不应关联的股票',
      symbol: 'sh600415',
    },
    undefined,
    { now, createId: () => 'daily-b' },
  ).note;
  assert.equal(second.code, '');
  assert.equal(second.name, '');
  assert.equal(Object.hasOwn(JSON.parse(store.read())[0], 'symbol'), false);
  const mixed = readResearchNotes(store.read());
  assert.deepEqual(
    mixed.map((note) => note.id),
    ['daily-b', 'daily-a', old.id],
  );
  assert.equal(
    mixed.filter((note) => researchNoteKind(note) === 'daily').length,
    2,
  );
  assert.deepEqual(mixed[2], old);
  assert.ok(validateSnapshot({ [RESEARCH_NOTES_KEY]: store.read() }));
  assert.deepEqual(
    removeResearchNote(store, first.id).map((note) => note.id),
    ['daily-b', old.id],
  );
});

test('research dates are real calendar days and today always uses Shanghai rather than the host timezone', () => {
  for (const day of [
    '2024-02-29',
    '2000-02-29',
    '2026-10-18',
    '0001-01-01',
    '9999-12-31',
  ])
    assert.equal(isResearchDate(day), true, day);
  for (const day of [
    undefined,
    null,
    20261018,
    '',
    '2026-2-01',
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '0000-01-01',
    ' 2026-10-18',
    '2026-10-18T00:00:00Z',
  ])
    assert.equal(isResearchDate(day), false, String(day));
  assert.equal(
    todayResearchDate(new Date('2026-10-17T15:59:59Z')),
    '2026-10-17',
  );
  assert.equal(
    todayResearchDate(new Date('2026-10-17T16:00:00Z')),
    '2026-10-18',
  );
});

test('daily editing preserves omitted kind, entry date, original text and legacy metadata; a deliberate date change is saved by ID', () => {
  const daily = {
    id: 'daily-old',
    kind: 'daily',
    entryDate: '2024-02-29',
    code: '',
    name: '',
    title: '旧标题',
    text: '  \n旧心得原文\n  ',
    date: '2024/3/1',
    extra: { pinned: true },
  };
  const store = memory([old, daily]);
  const renamed = saveResearchNote(
    store,
    { id: daily.id, title: '  新标题  ', text: daily.text },
    daily,
    { now },
  ).note;
  assert.equal(renamed.kind, 'daily');
  assert.equal(renamed.entryDate, daily.entryDate);
  assert.equal(renamed.date, daily.date);
  assert.equal(renamed.text, daily.text);
  assert.deepEqual(renamed.extra, daily.extra);
  const moved = saveResearchNote(
    store,
    {
      id: renamed.id,
      entryDate: '2024-03-01',
      text: renamed.text,
      title: '  ',
    },
    renamed,
    { now },
  ).note;
  assert.equal(moved.entryDate, '2024-03-01');
  assert.equal(moved.title, undefined);
  assert.equal(moved.id, daily.id);
  assert.equal(moved.text, daily.text);
  assert.equal(Object.hasOwn(moved, 'symbol'), false);
  assert.deepEqual(JSON.parse(store.read())[1], old);
});

test('legacy notes stay company notes even with missing company metadata; daily kind must be deliberate and cannot convert existing entries', () => {
  assert.equal(researchNoteKind(old), 'company');
  assert.equal(researchNoteKind({ code: '', name: '' }), 'company');
  assert.equal(researchNoteKind({ kind: 'company' }), 'company');
  assert.equal(researchNoteKind({ kind: 'daily' }), 'daily');
  assert.equal(
    researchNoteSymbol({ kind: 'daily', code: '600415', symbol: 'sh600415' }),
    '',
  );
  const missing = {
    id: 'legacy-no-stock',
    text: '保留旧笔记',
    arbitrary: { keep: true },
  };
  const parsed = readResearchNotes(JSON.stringify([missing]))[0];
  assert.equal(researchNoteKind(parsed), 'company');
  assert.deepEqual(parsed.arbitrary, missing.arbitrary);
  const oldMetadata = { ...old, entryDate: '旧扩展字段' };
  assert.deepEqual(readResearchNotes(JSON.stringify([oldMetadata])), [
    oldMetadata,
  ]);
  assert.equal(
    saveResearchNote(memory([oldMetadata]), oldMetadata, oldMetadata, { now })
      .note.entryDate,
    oldMetadata.entryDate,
  );
  const empty = memory([]);
  assert.throws(
    () => saveResearchNote(empty, { text: '没有选择公司' }),
    /请选择所属公司/,
  );
  const daily = {
    ...old,
    id: 'daily',
    kind: 'daily',
    code: '',
    name: '',
    entryDate: '2026-10-18',
  };
  for (const [existing, candidate] of [
    [old, { ...old, kind: 'daily', entryDate: '2026-10-18' }],
    [daily, { ...daily, ...input, id: daily.id, kind: 'company' }],
  ]) {
    const store = memory([existing]);
    const before = store.read();
    assert.throws(
      () => saveResearchNote(store, candidate, existing),
      /类型不能修改/,
    );
    assert.equal(store.read(), before);
  }
});

test('invalid daily dates and note kinds fail without saving; date-only changes in another tab reject a stale draft', () => {
  for (const entryDate of [
    '',
    '2026-02-29',
    '2026-04-31',
    '2026-10-18T00:00:00Z',
    null,
    20261018,
  ]) {
    const store = memory();
    const before = store.read();
    assert.throws(
      () =>
        saveResearchNote(store, { kind: 'daily', entryDate, text: '不会保存' }),
      /有效的心得日期/,
    );
    assert.equal(store.read(), before);
  }
  const store = memory();
  assert.throws(
    () => saveResearchNote(store, { kind: 'unknown', text: '不会保存' }),
    /类型无效/,
  );
  const expected = {
    ...old,
    kind: 'daily',
    code: '',
    name: '',
    entryDate: '2026-10-18',
  };
  const changed = { ...expected, entryDate: '2026-10-17' };
  const changedStore = memory([changed]);
  const before = changedStore.read();
  assert.throws(
    () =>
      saveResearchNote(
        changedStore,
        { id: old.id, text: '陈旧编辑' },
        expected,
      ),
    /其他页面更新/,
  );
  assert.equal(changedStore.read(), before);
  const changedKindStore = memory([{ ...expected, kind: 'company' }]);
  const changedKindBefore = changedKindStore.read();
  assert.throws(
    () =>
      saveResearchNote(
        changedKindStore,
        { id: old.id, text: '类型已变化的陈旧编辑' },
        expected,
      ),
    /其他页面更新/,
  );
  assert.equal(changedKindStore.read(), changedKindBefore);
});

test('optional manual titles trim on save while legacy titles and arbitrary extension fields retain their original values on read', () => {
  const legacy = {
    ...old,
    title: '  原标题  ',
    tags: ['核心研究'],
    extra: { source: 'legacy', enabled: true },
  };
  assert.deepEqual(parseResearchNotes([legacy]), [legacy]);
  assert.deepEqual(readResearchNotes(JSON.stringify([legacy])), [legacy]);
  const store = memory([legacy]);
  const { note } = saveResearchNote(
    store,
    { ...input, title: '  手动填写的标题\n ' },
    undefined,
    { now, createId: () => 'new-title' },
  );
  assert.equal(note.title, '手动填写的标题');
  assert.equal(note.text, input.text.trim());
  assert.equal(JSON.parse(store.read())[0].title, note.title);
  assert.deepEqual(JSON.parse(store.read())[1], legacy);
});

test('old callers preserve a saved title; explicit rename and clearing preserve IDs, body and extension metadata', () => {
  const legacy = {
    ...old,
    title: '既有标题',
    text: '  \n旧笔记原文\n  ',
    extra: { source: 'legacy' },
  };
  const store = memory([legacy]);
  const withoutTitle = { ...old, text: legacy.text };
  const preserved = saveResearchNote(store, withoutTitle, legacy, { now }).note;
  assert.equal(preserved.title, legacy.title);
  assert.equal(preserved.text, legacy.text);
  assert.deepEqual(preserved.extra, legacy.extra);
  const renamed = saveResearchNote(
    store,
    { ...preserved, title: '  重命名标题  ' },
    preserved,
    { now },
  ).note;
  assert.equal(renamed.title, '重命名标题');
  assert.equal(renamed.id, legacy.id);
  assert.equal(renamed.date, legacy.date);
  assert.equal(renamed.text, legacy.text);
  assert.equal(JSON.parse(store.read())[0].text, legacy.text);
  assert.deepEqual(renamed.extra, legacy.extra);
  const cleared = saveResearchNote(
    store,
    { ...renamed, title: '  \n  ' },
    renamed,
    { now },
  ).note;
  assert.equal(cleared.title, undefined);
  assert.equal(Object.hasOwn(JSON.parse(store.read())[0], 'title'), false);
  assert.equal(cleared.id, legacy.id);
  assert.equal(cleared.text, legacy.text);
  assert.equal(JSON.parse(store.read())[0].text, legacy.text);
  assert.deepEqual(cleared.extra, legacy.extra);
  const edited = saveResearchNote(
    store,
    { ...cleared, text: '  \n实际修改正文\n  ' },
    cleared,
    { now },
  ).note;
  assert.equal(edited.text, '实际修改正文');
  assert.deepEqual(edited.extra, legacy.extra);
});

test('a concurrent title-only rename or clearing rejects stale drafts even if timestamps and body are unchanged', () => {
  const expected = { ...old, title: '原标题', updatedAt: now.toISOString() };
  for (const title of ['另一页面重命名', undefined]) {
    const latest = { ...expected, title };
    const store = memory([latest]);
    const before = store.read();
    assert.throws(
      () =>
        saveResearchNote(
          store,
          { ...expected, text: '陈旧草稿正文' },
          expected,
          { now },
        ),
      /其他页面更新/,
    );
    assert.equal(store.read(), before);
  }
});

test('editing and deletion merge by ID against latest storage, preserving other-tab additions', () => {
  const store = memory([
    { ...input, id: 'other-tab', date: '2026/10/18' },
    { ...old, extra: 1 },
  ]);
  const { note, notes } = saveResearchNote(
    store,
    { ...old, text: '更新后的投资逻辑' },
    old,
    { now },
  );
  assert.equal(note.id, old.id);
  assert.equal(note.date, old.date);
  assert.equal(note.extra, 1);
  assert.deepEqual(
    notes.map((n) => n.id),
    ['old', 'other-tab'],
  );
  assert.deepEqual(
    removeResearchNote(store, old.id).map((n) => n.id),
    ['other-tab'],
  );
  assert.deepEqual(
    removeResearchNote(store, 'already-removed').map((n) => n.id),
    ['other-tab'],
  );
});

test('concurrent changes or deletion reject stale edits without changing saved notes', () => {
  for (const latest of [
    [{ ...old, text: '另一标签修改' }],
    [{ ...old, updatedAt: now.toISOString() }],
    [],
  ]) {
    const store = memory(latest),
      before = store.read();
    assert.throws(
      () => saveResearchNote(store, { ...old, text: '陈旧编辑' }, old),
      /其他页面更新|已被删除/,
    );
    assert.equal(store.read(), before);
  }
});

test('malformed saved data is never silently replaced during saves or deletions', () => {
  for (const raw of [
    'broken json',
    '{}',
    '[null]',
    '[{"id":"a","text":4}]',
    JSON.stringify([{ ...old, title: 123 }]),
    JSON.stringify([{ ...old, title: null }]),
    JSON.stringify([{ ...old, title: ['invalid'] }]),
    JSON.stringify([{ ...old, kind: 'unknown' }]),
    JSON.stringify([{ ...old, kind: null }]),
    JSON.stringify([{ ...old, kind: 'daily' }]),
    JSON.stringify([{ ...old, kind: 'daily', entryDate: '2026-02-29' }]),
    JSON.stringify([{ ...old, kind: 'daily', entryDate: 20261018 }]),
    JSON.stringify([{ ...old, entryDate: null }]),
    JSON.stringify([old, old]),
  ]) {
    const store = {
      read: () => raw,
      write: () => assert.fail('must not write over unreadable notes'),
    };
    assert.throws(() => saveResearchNote(store, input), /读取失败/);
    assert.throws(() => removeResearchNote(store, old.id), /读取失败/);
  }
  assert.deepEqual(readResearchNotes(null), []);
});

test('blank input and failed persistence leave stored notes untouched', () => {
  const store = memory(),
    before = store.read();
  assert.throws(
    () => saveResearchNote(store, { ...input, text: '  \n  ' }),
    /填写笔记内容/,
  );
  assert.equal(store.read(), before);
  const blankStore = memory([{ ...old, text: '  \n  ' }]);
  const blankBefore = blankStore.read();
  assert.throws(
    () =>
      saveResearchNote(blankStore, { ...old, text: '  \n  ', title: '新标题' }),
    /填写笔记内容/,
  );
  assert.equal(blankStore.read(), blankBefore);
  const unavailable = {
    read: store.read,
    write: () => {
      throw new Error('quota');
    },
  };
  assert.throws(() => saveResearchNote(unavailable, input), /quota/);
  assert.throws(() => removeResearchNote(unavailable, old.id), /quota/);
  assert.equal(store.read(), before);
});

test('saved notes sync while drafts remain local to their own account', () => {
  assert.equal(isCloudKey(RESEARCH_NOTES_KEY), true);
  assert.equal(isCloudKey(RESEARCH_NOTE_DRAFT_KEY), false);
  assert.equal(isCloudKey(DAILY_NOTE_DRAFT_KEY), false);
  assert.notEqual(DAILY_NOTE_DRAFT_KEY, RESEARCH_NOTE_DRAFT_KEY);
  assert.notEqual(
    storageKey(DAILY_NOTE_DRAFT_KEY, 'a'),
    storageKey(DAILY_NOTE_DRAFT_KEY, 'b'),
  );
  assert.notEqual(
    storageKey(DAILY_NOTE_DRAFT_KEY, null),
    storageKey(DAILY_NOTE_DRAFT_KEY, 'a'),
  );
  assert.notEqual(
    storageKey(RESEARCH_NOTE_DRAFT_KEY, 'a'),
    storageKey(RESEARCH_NOTE_DRAFT_KEY, 'b'),
  );
  assert.notEqual(
    storageKey(RESEARCH_NOTE_DRAFT_KEY, null),
    storageKey(RESEARCH_NOTE_DRAFT_KEY, 'a'),
  );
});
