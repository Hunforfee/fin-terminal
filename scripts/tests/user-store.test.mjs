import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load } from './load-modules.mjs';

const root = process.cwd();
const work = path.dirname(root);
const temporary = fs.mkdtempSync(path.join(work, '.user-store-test-'));
assert.equal(path.dirname(temporary), work);
const directory = path.join(temporary, 'data');
const file = path.join(directory, 'auth-accounts.json');
let storage;
try {
  process.chdir(temporary);
  storage = await load('auth/userStore');
} finally {
  process.chdir(root);
}
const { registerUser, verifyUser, normalizeUsername, AccountStoreError } =
  storage;

beforeEach(() => fs.rmSync(directory, { recursive: true, force: true }));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('accounts persist salted hashes and case-insensitive login; duplicate registration preserves records', () => {
  const first = registerUser('TestUser', 'a-test-password');
  assert.equal(verifyUser('testuser', 'a-test-password').id, first.id);
  assert.throws(() => verifyUser('testuser', 'incorrect'), /用户名或密码错误/);
  assert.throws(
    () => verifyUser('missing-user', 'incorrect'),
    /用户名或密码错误/,
  );
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(original.includes('a-test-password'), false);
  assert.throws(() => registerUser('TESTUSER', 'another-password'), /已被注册/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('invalid numeric usernames are rejected before account files are written; prototype names remain ordinary accounts', () => {
  for (const name of ['13800000000', '12345678901', '00000000000']) {
    assert.equal(normalizeUsername(name), null);
    assert.throws(() => registerUser(name, 'a-test-password'), /用户名/);
    assert.equal(fs.existsSync(file), false);
  }
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const user = registerUser(name, 'a-test-password');
    assert.equal(verifyUser(name, 'a-test-password').id, user.id);
    assert.throws(() => registerUser(name, 'other-password'), /已被注册/);
  }
  assert.equal(
    Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).accounts).length,
    3,
  );
});

test('corrupt, malformed and unreadable account stores reject mutations without replacing original data', () => {
  fs.mkdirSync(directory);
  for (const raw of [
    '{"accounts":',
    'null',
    '[]',
    '{}',
    '{"accounts":null}',
    '{"accounts":[]}',
    '{"accounts":{"someone":{}}}',
    '{"accounts":{"someone":{"id":"x","hash":"bad","salt":"bad","createdAt":0}}}',
  ]) {
    fs.writeFileSync(file, raw);
    assert.throws(
      () => registerUser('new-user', 'a-test-password'),
      AccountStoreError,
    );
    assert.throws(
      () => verifyUser('someone', 'a-test-password'),
      AccountStoreError,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(directory), ['auth-accounts.json']);
  }
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(
    () => registerUser('new-user', 'a-test-password'),
    AccountStoreError,
  );
  assert.equal(fs.statSync(file).isDirectory(), true);
});
