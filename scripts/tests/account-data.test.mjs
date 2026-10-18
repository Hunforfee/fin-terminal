import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load } from './load-modules.mjs';

// The storage module captures cwd on import. Keep every test write inside a
// dedicated temporary directory, without touching real account data.
const root = process.cwd();
const temporary = fs.mkdtempSync(
  path.join(root, 'node_modules', '.account-data-test-'),
);
assert.equal(path.dirname(temporary), path.join(root, 'node_modules'));
const directory = path.join(temporary, 'data');
const file = path.join(directory, 'account-data.json');
const databaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
let storage;
try {
  process.chdir(temporary);
  storage = await load('auth/accountData');
} finally {
  process.chdir(root);
}
const { readAccountData, writeAccountData, dataSyncReady } = storage;

beforeEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
after(() => {
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('missing file initializes safely; file data persists by account and stale revisions cannot overwrite it', async () => {
  assert.equal(dataSyncReady(), true);
  assert.deepEqual(await readAccountData('account-a'), {
    revision: 0,
    data: {},
  });
  const a = { 'fin.research.notes.v1': '[{"id":"a","text":"own note"}]' };
  const b = { 'fin.ai.prompt': 'account b' };
  assert.deepEqual(await writeAccountData('account-a', 0, a), {
    revision: 1,
    data: a,
  });
  assert.deepEqual(await writeAccountData('account-b', 0, b), {
    revision: 1,
    data: b,
  });
  assert.equal(await writeAccountData('account-a', 0, {}), null);
  assert.deepEqual(await readAccountData('account-a'), {
    revision: 1,
    data: a,
  });
  assert.deepEqual(await readAccountData('account-b'), {
    revision: 1,
    data: b,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).users['account-a'].data,
    a,
  );
  assert.deepEqual(fs.readdirSync(directory), ['account-data.json']);
});

test('two saves of the same revision accept exactly one change in a single process', async () => {
  const results = await Promise.all([
    writeAccountData('account-a', 0, { 'fin.ai.prompt': 'first' }),
    writeAccountData('account-a', 0, { 'fin.ai.prompt': 'second' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await readAccountData('account-a'), results.find(Boolean));
});

test('corrupt JSON and malformed store records reject both reads and saves, preserving every original byte', async () => {
  fs.mkdirSync(directory);
  const invalid = [
    '{"users":{"other-account":',
    'null',
    '[]',
    '{}',
    '{"users":null}',
    '{"users":[]}',
    '{"users":{"account-a":null}}',
    '{"users":{"account-a":{"revision":"1","data":{}}}}',
    '{"users":{"account-a":{"revision":-1,"data":{}}}}',
    '{"users":{"account-a":{"revision":0,"data":[]}}}',
    '{"users":{"account-a":{"revision":0,"data":{"fin.ai.prompt":null}}}}',
  ];
  for (const raw of invalid) {
    fs.writeFileSync(file, raw);
    await assert.rejects(readAccountData('account-a'));
    await assert.rejects(
      writeAccountData('account-a', 0, { 'fin.ai.prompt': 'replacement' }),
    );
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(directory), ['account-data.json']);
  }
});

test('an unreadable storage path is an error rather than an empty account', async () => {
  fs.mkdirSync(file, { recursive: true });
  await assert.rejects(readAccountData('account-a'));
  await assert.rejects(writeAccountData('account-a', 0, {}));
  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(directory), ['account-data.json']);
});
