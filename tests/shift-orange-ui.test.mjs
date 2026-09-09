import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const orangeOverrideAt = html.indexOf('2026-09 オレンジUI確認版');

test('オレンジUIは既存処理の後段CSSだけで適用する', () => {
  assert.ok(orangeOverrideAt > 0);
  assert.ok(orangeOverrideAt < html.indexOf('</style>'));
  assert.ok(orangeOverrideAt > html.indexOf('.header { background: #06c755'));
});

test('上部のシフト申請ヘッダーをオレンジにする', () => {
  const css = html.slice(orangeOverrideAt, html.indexOf('</style>', orangeOverrideAt));
  assert.match(css, /\.header\s*\{[\s\S]*?background:linear-gradient\([^}]*#e9681f/i);
  assert.match(html, /meta name="theme-color" content="#E9681F"/);
});

test('本文と主要操作の文字を太くする', () => {
  const css = html.slice(orangeOverrideAt, html.indexOf('</style>', orangeOverrideAt));
  assert.match(css, /body\s*\{[\s\S]*?font-weight:600/);
  assert.match(css, /\.header h1\s*\{[^}]*font-weight:900/);
  assert.match(css, /\.btn-submit\s*\{[^}]*font-weight:900/);
  assert.match(css, /\.nav-btn\s*\{[^}]*font-weight:800/);
});

test('認証・通信・操作スクリプトは残っている', () => {
  assert.match(html, /transport:'authenticatedWeb'/);
  assert.match(html, /async function loadStaff\(\)/);
  assert.match(html, /function submitApply\(/);
  assert.match(html, /function switchTab\(/);
});
