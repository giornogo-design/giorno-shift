import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');

function functionBody(name) {
  const start = SRC.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} が存在すること`);
  const next = SRC.indexOf('\nfunction ', start + 10);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

test('C1: LIFFの生ID tokenを取得してauthPingへ渡す', () => {
  const body = functionBody('observePhase05Auth_');
  assert.match(body, /liff\.getIDToken\(\)/);
  assert.match(body, /action:'authPing'/);
  assert.match(body, /idToken:idToken/);
});

test('C2: ID tokenはPOST本文に入りURLへ連結されない', () => {
  const body = functionBody('gasAuthenticatedPost');
  assert.match(body, /method:'POST'/);
  assert.match(body, /URLSearchParams/);
  assert.doesNotMatch(body, /GAS_URL\s*\+\s*['"]\?['"]/);
});

test('C3: 認証観測に専用transportを使い既存管理者POSTと分離する', () => {
  const authBody = functionBody('gasAuthenticatedPost');
  const adminBody = SRC.slice(SRC.indexOf('async function gasPost'), SRC.indexOf('async function gasAuthenticatedPost'));
  assert.match(authBody, /transport:'authenticatedWeb'/);
  assert.match(adminBody, /transport:'adminShift'/);
});

test('C4: 観測失敗でもinitの既存プロフィール取得を継続する', () => {
  const body = functionBody('init');
  const observeAt = body.indexOf('observePhase05Auth_();');
  const profileAt = body.indexOf('await liff.getProfile()');
  assert.ok(observeAt >= 0 && profileAt > observeAt);
  assert.doesNotMatch(body, /await\s+observePhase05Auth_/);
});

test('C5: 観測結果にtokenや個人情報を公開しない', () => {
  const getterAt = SRC.indexOf('window.getPhase05AuthObservation');
  assert.notEqual(getterAt, -1);
  const getter = SRC.slice(getterAt, SRC.indexOf('\n};', getterAt) + 3);
  assert.match(getter, /status:/);
  assert.match(getter, /checkedAt:/);
  assert.doesNotMatch(getter, /idToken|lineId|staff|name/);
});
