'use strict';
// SHIFT-022 UI復旧: 登録リクエストのタイムアウト・ローディング解除・二重登録防止の検証。
// 実時間は待たず、context に注入した擬似タイマーで30秒を進める。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker);
  assert.ok(s >= 0, 'マーカーが見つかりません: ' + startMarker);
  assert.ok(e > s, 'マーカーが見つかりません: ' + endMarker);
  return html.slice(s, e);
}

// 検証対象のソース範囲。通信層・管理者セッション・成功判定・登録処理。
const SOURCE = [
  slice('const ADMIN_REQUEST_TIMEOUT_MS', '// 認証（LIFF）'),
  slice('function adminRequestId()', 'async function openAdminShiftEntry'),
  slice('// 結果未確定の操作が残っている間は登録ボタンを押せない', 'async function editAdminEntryExisting')
].join('\n');

// ---------------------------------------------------------------- 擬似タイマー
function makeClock() {
  let now = 0, seq = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = seq++; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      now += ms;
      Array.from(timers.entries())
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at)
        .forEach(([id, t]) => { timers.delete(id); t.fn(); });
    },
    count() { return timers.size; }
  };
}

// マイクロタスクを流し切る。await 連鎖が数段あるため複数回まわす。
function flush() {
  return new Promise(resolve => {
    let n = 0;
    (function step() { if (++n >= 12) return resolve(); setImmediate(step); })();
  });
}

// ---------------------------------------------------------------- 擬似DOM
// opt.noScrollIntoView=true で scrollIntoView 非対応環境、
// opt.scrollThrows=true で scrollIntoView が例外を投げる環境を再現する。
function makeDoc(opt) {
  const o = opt || {};
  const els = {};
  const reveals = [];
  const get = id => els[id] || (els[id] = Object.assign({
    id, style: {}, dataset: {}, textContent: '', innerHTML: '', className: '', disabled: false,
    appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }
  }, o.noScrollIntoView ? {} : {
    scrollIntoView(arg) {
      if (o.scrollThrows) throw new TypeError('scrollIntoView is not supported here');
      reveals.push({ id, arg });
    }
  }));
  return { getElementById: get, querySelectorAll: () => [], _els: els, _reveals: reveals };
}

// ---------------------------------------------------------------- 環境
function makeEnv(options) {
  const opt = options || {};
  const clock = makeClock();
  const doc = makeDoc(opt);
  const calls = [];           // 送信された1件ごとの {url, params}
  const statuses = [];        // 画面に出た文言

  // 応答スクリプト。1回の送信につき1要素を消費する。
  const responses = (opt.responses || []).slice();

  function fetchStub(url, init) {
    const params = {};
    if (init && init.body) new ctx.URLSearchParams(init.body).forEach((v, k) => { params[k] = v; });
    const call = { url, params, signal: init && init.signal, late: null };
    calls.push(call);
    const spec = responses.shift() || { kind: 'hang' };

    if (spec.kind === 'hang') {
      // 応答が返らない通信。abort されたときだけ棄却する。
      // late.resolve / late.reject で「打ち切り後に遅れて届く応答」を作れる。
      return new Promise((resolve, reject) => {
        call.late = {
          resolve: json => resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(json)) }),
          reject: () => reject(new TypeError('Failed to fetch'))
        };
        const sig = init && init.signal;
        if (sig) sig.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (spec.kind === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
    if (spec.kind === 'http') return Promise.resolve({ ok: false, status: spec.status, text: () => Promise.resolve('') });
    const text = spec.kind === 'text' ? spec.text : JSON.stringify(spec.json);
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  }

  const ctx = {
    console,
    URLSearchParams,
    // opt.noAbortController=true で AbortController 非対応環境を再現する
    AbortController: opt.noAbortController ? undefined : AbortController,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setImmediate,
    document: doc,
    fetch: fetchStub,
    confirm: () => (opt.confirm === undefined ? true : opt.confirm),
    crypto: { randomUUID: () => 'rid-' + (ctx.__ridSeq = (ctx.__ridSeq || 0) + 1) + '-0000-0000-0000-000000000000' },
    GAS_URL: 'https://example.invalid/exec',
    liff: { getIDToken: () => 'ID_TOKEN_STUB' },
    // 既定は認証済みとして扱い、1操作=1リクエストになるようにする。
    // opt.noToken=true でセッション作成から始まる経路を再現する。
    adminShiftToken: opt.noToken ? null : 'TESTTOKEN',
    adminShiftSessionPromise: null,
    adminEntryBusy: false,
    adminEntryPendingRequest: null,
    adminEntryStaff: { id: 'PT016', name: '中山　佳男' },
    adminEntryStore: { id: 'ST1', name: '片町' },
    adminEntrySelected: {},
    adminEntryExisting: [],
    adminEntryYear: 2026,
    adminEntryMonth: 9,
    // 検証対象外の描画・読込はスタブにする
    setNet() {},
    renderAdminEntryCalendar() {},
    renderAdminEntrySelected() {},
    adminEntryDateKey: (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
    dispEnd: (s, e) => e,
    // 本番の loadAdminEntryExisting は例外を投げず {ok,loaded,error} を返す。
    // スタブも同じ契約にする（内部catchのぶんだけ本番と経路が一致する）。
    // opt.existingViaFetch=true のときは実際に通信層を通す（応答スクリプトが挙動を決める）。
    loadAdminEntryExisting: async () => {
      ctx.adminEntryExisting = [];
      if (opt.notLoaded) return { ok: true, loaded: false };
      if (opt.existingViaFetch) {
        try {
          const d = await ctx.adminShiftGet({ action: 'adminGetShiftEntries' }, false, { timeoutMs: 30000 });
          if (!d || !d.ok) throw new Error((d && d.error) || '既存シフトを取得できません。');
          ctx.adminEntryExisting = d.shifts || [];
          return { ok: true, loaded: true };
        } catch (e) {
          ctx.showAdminEntryStatus(e.message, true);   // 本番同様、内部で表示してから返す
          return { ok: false, error: e };
        }
      }
      ctx.adminEntryExisting = (opt.existingAfterSave || []);
      return { ok: true, loaded: true };
    },
    loadConfirmData: async () => {}
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);

  const rawStatus = ctx.showAdminEntryStatus;
  ctx.showAdminEntryStatus = function (message, isError) { statuses.push(String(message || '')); return rawStatus(message, isError); };

  ctx.adminEntrySelected = opt.selected || { '2026-09-15': { year: 2026, month: 9, day: 15, start: '17:00', end: '22:00' } };
  return { ctx, clock, doc, calls, statuses, responses,
    status: () => statuses[statuses.length - 1] || '',
    allStatus: () => statuses.join('\n---\n'),
    submitBtn: () => doc.getElementById('admin-entry-submit'),
    recheckBtn: () => doc.getElementById('admin-entry-recheck'),
    reveals: () => doc._reveals };
}

const COMPLETED_OK = {
  kind: 'json',
  json: { ok: true, saved: [{ id: 'SH1', year: 2026, month: 9, day: 15, start: '17:00', end: '22:00', operationStatus: 'COMPLETED' }], errors: [] }
};
const REPLAYED_OK = {
  kind: 'json',
  json: { ok: true, replayed: true, saved: [{ id: 'SH1', year: 2026, month: 9, day: 15, start: '17:00', end: '22:00', operationStatus: 'COMPLETED' }], errors: [] }
};

// 画面が操作可能な状態へ戻っていること。全経路で共通に確認する。
function assertRecovered(env, label) {
  assert.strictEqual(env.ctx.adminEntryBusy, false, label + ': 二重送信防止フラグが解除されていない');
  assert.strictEqual(env.submitBtn().textContent, '内容を確認して登録', label + ': ボタン表示が戻っていない');
  assert.ok(!/登録中です/.test(env.status()), label + ': 「登録中」表示が残っている');
}

// ---------------------------------------------------------------- テスト実行
let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

test('1. 通常成功: 登録完了しローディングが解除される', async () => {
  const env = makeEnv({ responses: [COMPLETED_OK], existingAfterSave: [{ id: 'SH1' }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assert.strictEqual(env.calls.length, 1, '送信は1回');
  assert.ok(/1件を管理者登録しました/.test(env.status()), '成功表示: ' + env.status());
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, '保留は解除される');
  assertRecovered(env, '通常成功');
});

test('2. バックエンド業務エラー: 結果は確定しており保留を残さない', async () => {
  const env = makeEnv({ responses: [{ kind: 'json', json: { ok: false, error: '対象スタッフはこの店舗へ登録できません。' } }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assert.strictEqual(env.calls.length, 1, '業務エラーでは結果確認を追加送信しない');
  assert.ok(/対象スタッフはこの店舗へ登録できません/.test(env.status()), '業務エラー文言: ' + env.status());
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, '結果が判明したので保留しない');
  assertRecovered(env, '業務エラー');
});

test('3. HTTPエラー: HTTPと明示し、結果確認を行う', async () => {
  const env = makeEnv({ responses: [{ kind: 'http', status: 500 }, { kind: 'http', status: 500 }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assert.ok(/HTTP 500/.test(env.allStatus()), 'HTTPエラーを区別: ' + env.allStatus());
  assert.ok(/登録結果不明/.test(env.status()), '結果不明として扱う: ' + env.status());
  assert.ok(!/もう一度登録してください/.test(env.allStatus()), '再登録を促してはいけない');
  assertRecovered(env, 'HTTPエラー');
});

test('4. JSON解析エラー: 解析失敗を区別しローディングを解除する', async () => {
  const env = makeEnv({ responses: [{ kind: 'text', text: '<html>error</html>' }, { kind: 'text', text: '<html>error</html>' }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assert.ok(/JSON解析エラー/.test(env.allStatus()), 'JSON解析エラーを区別: ' + env.allStatus());
  assertRecovered(env, 'JSON解析エラー');
});

test('5. ネットワーク拒否: ネットワークエラーとして表示する', async () => {
  const env = makeEnv({ responses: [{ kind: 'reject' }, { kind: 'reject' }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assert.ok(/ネットワークエラー/.test(env.allStatus()), 'ネットワークエラーを区別: ' + env.allStatus());
  assert.ok(/登録結果不明/.test(env.status()), '結果不明として扱う: ' + env.status());
  assertRecovered(env, 'ネットワーク拒否');
});

test('6. 30秒間応答なし: タイムアウトして画面が戻る', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, { kind: 'hang' }] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  assert.strictEqual(env.ctx.adminEntryBusy, true, 'タイムアウト前は登録中のまま');
  env.clock.tick(30000);        // 実時間は待たない
  await flush();
  env.clock.tick(30000);        // 結果確認側もタイムアウトさせる
  await flush();
  await p;
  assert.ok(/通信タイムアウト/.test(env.allStatus()), 'タイムアウトを区別: ' + env.allStatus());
  assert.ok(/30秒で打ち切りました/.test(env.allStatus()), '30秒で打ち切る: ' + env.allStatus());
  assertRecovered(env, 'タイムアウト');
  assert.strictEqual(env.clock.count(), 0, 'タイマーが解除されている');
});

test('7. タイムアウト直後にバックエンド完了: 完了として表示する', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, REPLAYED_OK] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(/前回の登録は完了していました/.test(env.status()), '完了表示: ' + env.status());
  assert.ok(/重複登録はありません/.test(env.status()), '重複なしを明示: ' + env.status());
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, '結果確定で保留解除');
  assertRecovered(env, 'タイムアウト後完了');
});

test('8. タイムアウト後も処理中: 再確認できる表示にする', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, { kind: 'json', json: { ok: false, error: '他のシフト処理が実行中です。完了後にもう一度お試しください。' } }] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(/まだ処理中/.test(env.status()), '処理中表示: ' + env.status());
  assert.ok(/もう一度登録しないでください/.test(env.status()), '再登録を止める: ' + env.status());
  assert.ok(env.ctx.adminEntryPendingRequest, '結果未確定なので保留を維持');
  assert.strictEqual(env.recheckBtn().style.display, 'block', '再確認ボタンを出す');
  assert.strictEqual(env.submitBtn().disabled, true, '登録ボタンは押せない');
  assertRecovered(env, '処理中');
});

test('9. requestIdで完了結果を再取得できる', async () => {
  const env = makeEnv({ responses: [
    { kind: 'hang' },
    { kind: 'json', json: { ok: false, error: '他のシフト処理が実行中です。完了後にもう一度お試しください。' } },
    REPLAYED_OK
  ] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  const held = env.ctx.adminEntryPendingRequest.requestId;
  await env.ctx.recheckAdminShiftRequest();   // 利用者が「登録結果を再確認する」を押す
  await flush();
  assert.strictEqual(env.calls.length, 3, '再確認で1回だけ送信');
  assert.strictEqual(env.calls[2].params.requestId, held, '同じrequestIdで再取得');
  assert.ok(/前回の登録は完了していました/.test(env.status()), '完了として取得: ' + env.status());
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, '確定したので保留解除');
  assertRecovered(env, '再取得');
});

test('10. ダブルクリック: 2回押しても送信は1回', async () => {
  const env = makeEnv({ responses: [COMPLETED_OK], existingAfterSave: [{ id: 'SH1' }] });
  const p1 = env.ctx.submitAdminShiftEntries();
  const p2 = env.ctx.submitAdminShiftEntries();
  await Promise.all([p1, p2]);
  await flush();
  assert.strictEqual(env.calls.length, 1, '送信は1回: ' + env.calls.length);
  assertRecovered(env, 'ダブルクリック');
});

test('11. Enter連打: 5回発火しても送信は1回', async () => {
  const env = makeEnv({ responses: [COMPLETED_OK], existingAfterSave: [{ id: 'SH1' }] });
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(env.ctx.submitAdminShiftEntries());
  await Promise.all(ps);
  await flush();
  assert.strictEqual(env.calls.length, 1, '送信は1回: ' + env.calls.length);
  assertRecovered(env, 'Enter連打');
});

test('12. 例外後にボタンが再操作可能', async () => {
  const env = makeEnv({ responses: [
    { kind: 'json', json: { ok: false, error: '同じ時間帯が既に登録されています。' } },
    COMPLETED_OK
  ], existingAfterSave: [{ id: 'SH1' }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assertRecovered(env, '業務エラー後');
  assert.strictEqual(env.submitBtn().disabled, false, '選択が残っているので再度押せる');
  await env.ctx.submitAdminShiftEntries();   // 利用者の明示操作による再登録は可能
  await flush();
  assert.strictEqual(env.calls.length, 2, '明示操作で再送信できる');
  assert.notStrictEqual(env.calls[0].params.requestId, env.calls[1].params.requestId, '明示的な再登録は新しいrequestId');
});

test('13. 新しいrequestIdで勝手に再登録されない', async () => {
  const BUSY = { kind: 'json', json: { ok: false, error: '他のシフト処理が実行中です。完了後にもう一度お試しください。' } };
  // 1回目: 無応答 → 2回目(結果確認): 無応答 → 3回目(利用者の再確認): 処理中
  const env = makeEnv({ responses: [{ kind: 'hang' }, { kind: 'hang' }, BUSY] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  env.clock.tick(30000);   // 結果確認もタイムアウトさせる
  await flush();
  await p;
  assert.ok(/登録結果不明/.test(env.status()), '結果不明として止まる: ' + env.status());
  assert.ok(env.ctx.adminEntryPendingRequest, '保留を維持する');
  const firstId = env.calls[0].params.requestId;

  // 保留が残る間は登録ボタンを押しても新規登録にならず、結果確認だけを行う
  await env.ctx.submitAdminShiftEntries();
  await flush();
  const ids = env.calls.map(c => c.params.requestId);
  assert.strictEqual(env.calls.length, 3, '送信は結果確認までの3回');
  assert.strictEqual(new Set(ids).size, 1, 'requestIdが増えていない: ' + JSON.stringify(ids));
  assert.strictEqual(ids[2], firstId, '再操作でも同じrequestId');
  assertRecovered(env, '結果不明');
});

test('14. 同じrequestIdで状態確認される', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, REPLAYED_OK] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.strictEqual(env.calls.length, 2, '結果確認を1回送る');
  assert.strictEqual(env.calls[1].params.action, 'adminCreateShift', 'GASの冪等replayを使う');
  assert.strictEqual(env.calls[1].params.requestId, env.calls[0].params.requestId, '同じrequestIdで確認');
  assert.strictEqual(env.calls[1].params.shifts, env.calls[0].params.shifts, '内容も同一で送る');
});

// ---------------------------------------------------------------- AbortController非対応環境
// 要件: AbortController の有無にかかわらず30秒で必ずTIMEOUTとして戻ること。

test('15. AbortController非対応: fetchが永久に返らなくても30秒で戻る', async () => {
  const env = makeEnv({ noAbortController: true, responses: [{ kind: 'hang' }, { kind: 'hang' }] });
  assert.strictEqual(env.ctx.AbortController, undefined, 'AbortControllerが無い環境である');
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  assert.strictEqual(env.ctx.adminEntryBusy, true, '30秒前は登録中のまま');
  assert.strictEqual(env.calls[0].signal, undefined, 'signalは渡されない（非対応環境）');

  env.clock.tick(30000);                       // fake timerで30秒進める
  await flush();
  assert.ok(/通信タイムアウト/.test(env.allStatus()), 'TIMEOUTとして戻る: ' + env.allStatus());
  env.clock.tick(30000);                       // 結果確認側も打ち切る
  await flush();
  await p;

  assert.strictEqual(env.ctx.adminEntryBusy, false, 'adminEntryBusyがfalseへ戻る');
  assert.ok(!/登録中です/.test(env.status()), '登録中表示が解除される: ' + env.status());
  assert.strictEqual(env.submitBtn().textContent, '内容を確認して登録', 'ボタン表示が戻る');
  assert.strictEqual(env.calls.length, 2, '結果確認は1回だけ');
  assert.strictEqual(env.calls[1].params.requestId, env.calls[0].params.requestId, '同じrequestIdで結果確認');
  assert.strictEqual(env.calls[1].params.action, 'adminCreateShift', '新しい登録ではなく同一リクエストの再送');
  assert.strictEqual(env.clock.count(), 0, 'タイマーが全て解放されている');
});

test('16. AbortController非対応: タイムアウト後に元fetchが遅れて成功しても表示を上書きしない', async () => {
  const env = makeEnv({ noAbortController: true, responses: [{ kind: 'hang' }, { kind: 'hang' }] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;

  const statusAfterTimeout = env.status();
  const callsAfterTimeout = env.calls.length;
  assert.ok(/登録結果不明/.test(statusAfterTimeout), '結果不明で停止している: ' + statusAfterTimeout);

  // 打ち切った後になって、最初のfetchが遅れて成功する
  env.calls[0].late.resolve({ ok: true, saved: [{ id: 'SH9', year: 2026, month: 9, day: 15, operationStatus: 'COMPLETED' }], errors: [] });
  await flush();

  assert.strictEqual(env.status(), statusAfterTimeout, '遅延成功で画面表示が上書きされない');
  assert.strictEqual(env.calls.length, callsAfterTimeout, '遅延応答で追加送信が起きない');
  assert.ok(env.ctx.adminEntryPendingRequest, '保留状態も変化しない');
  assert.strictEqual(env.ctx.adminEntryBusy, false, '登録中へ戻らない');
});

test('17. AbortController非対応: タイムアウト後に元fetchが遅れて失敗しても未処理例外にならない', async () => {
  const rejections = [];
  const onUnhandled = r => rejections.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    const env = makeEnv({ noAbortController: true, responses: [{ kind: 'hang' }, { kind: 'hang' }] });
    const p = env.ctx.submitAdminShiftEntries();
    await flush();
    env.clock.tick(30000);
    await flush();
    env.clock.tick(30000);
    await flush();
    await p;

    const statusAfterTimeout = env.status();
    env.calls[0].late.reject();          // 打ち切り後に遅れて通信失敗
    env.calls[1].late.reject();
    await flush();

    assert.strictEqual(rejections.length, 0, '未処理のPromise棄却が発生しない: ' + rejections.map(String).join(','));
    assert.strictEqual(env.status(), statusAfterTimeout, '遅延失敗で画面表示が上書きされない');
    assert.strictEqual(env.ctx.adminEntryBusy, false, '画面は操作可能なまま');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('18. AbortController対応環境ではabortも実行される', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, { kind: 'hang' }] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  assert.ok(env.calls[0].signal, 'signalが渡されている');
  assert.strictEqual(env.calls[0].signal.aborted, false, '打ち切り前はabortされていない');
  env.clock.tick(30000);
  await flush();
  assert.strictEqual(env.calls[0].signal.aborted, true, 'タイムアウト時にabortされる');
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(/通信タイムアウト/.test(env.allStatus()), 'TIMEOUTとして扱う');
  assertRecovered(env, 'abort実行');
});

// ---------------------------------------------------------------- 確定順序
// 要件: abortが即座にAbortErrorを起こしても、30秒経過後は必ずTIMEOUTとして返すこと。

test('19. abort即時rejectでも確定種別はTIMEOUT（ABORTED/NETWORKにしない）', async () => {
  const rejections = [];
  const onUnhandled = r => rejections.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    // hangスタブは signal の abort を検知した瞬間に同期でAbortErrorを投げる
    const env = makeEnv({ responses: [{ kind: 'hang' }, { kind: 'hang' }] });
    const p = env.ctx.submitAdminShiftEntries();
    await flush();
    assert.ok(env.calls[0].signal, 'AbortController対応環境である');

    env.clock.tick(30000);
    await flush();
    env.clock.tick(30000);
    await flush();
    await p;

    const all = env.allStatus();
    assert.ok(/通信タイムアウト/.test(all), '4/5. TIMEOUTとして分類・表示: ' + all);
    assert.ok(!/通信を打ち切りました/.test(all), '4. ABORTEDとして表面化していない: ' + all);
    assert.ok(!/ネットワークエラー/.test(all), '4. NETWORKとして表面化していない: ' + all);
    assert.strictEqual(env.calls[0].signal.aborted, true, '通信も中断されている');

    assert.strictEqual(env.ctx.adminEntryBusy, false, '6. adminEntryBusy=false');
    assert.ok(!/登録中です/.test(env.status()), '7. 登録中表示が解除: ' + env.status());
    assert.strictEqual(env.submitBtn().textContent, '内容を確認して登録', '7. ボタン表示が復旧');

    assert.strictEqual(env.calls.length, 2, '9. 自動確認は1回だけ');
    assert.strictEqual(env.calls[1].params.requestId, env.calls[0].params.requestId, '8. 同じrequestIdで結果確認');
    assert.strictEqual(env.calls[1].params.action, 'adminCreateShift', '9. 新しい登録リクエストではない');
    assert.strictEqual(new Set(env.calls.map(c => c.params.requestId)).size, 1, '9. 新しいrequestIdを発行しない');

    assert.strictEqual(rejections.length, 0, '10. 未処理Promise rejectionが0件: ' + rejections.map(String).join(','));
    assert.strictEqual(env.clock.count(), 0, '11. タイマー残数0件');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('20. gasFetchJson_単体: abort即時rejectでも呼出元へはTIMEOUTが返る', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }] });
  let caught = null;
  env.ctx.gasFetchJson_('https://example.invalid/exec', { method: 'POST', body: '' }, 30000)
    .then(() => { caught = 'resolved'; }, e => { caught = e; });
  await flush();
  env.clock.tick(30000);
  await flush();
  assert.ok(caught && caught !== 'resolved', '棄却されている');
  assert.strictEqual(caught.gasErrorKind, 'TIMEOUT', '確定種別はTIMEOUT: ' + caught.gasErrorKind);
  assert.ok(/30秒で打ち切りました/.test(caught.message), 'TIMEOUT文言: ' + caught.message);
  assert.strictEqual(env.clock.count(), 0, 'タイマーが解放されている');
});

test('21. タイマー内の処理順が timedOut → reject → abort である', async () => {
  // 実装順序を固定する。abortを先に呼ぶ実装へ戻ると失敗する。
  const body = html.slice(html.indexOf('function gasFetchJson_'), html.indexOf('async function gasGet'));
  const iFlag  = body.indexOf('timedOut = true');
  const iRej   = body.indexOf('reject(timeoutError())');
  const iAbort = body.indexOf('ctrl.abort()');
  assert.ok(iFlag >= 0 && iRej >= 0 && iAbort >= 0, '3要素が存在する');
  assert.ok(iFlag < iRej, 'timedOutの設定がrejectより先');
  assert.ok(iRej < iAbort, 'rejectがabortより先');
  assert.ok(/timedOut && isAbortError_\(e\)/.test(body), 'AbortErrorのTIMEOUT正規化がある');
});

// ---------------------------------------------------------------- 修正A: 登録成功と再取得の分離
// 登録APIがCOMPLETEDなら、後続の再取得が失敗しても登録成功を失わないこと。

// 登録成功が確定した後の安全状態を共通に確認する。
function assertRegisteredSafely(env, label) {
  const s = env.status();
  assert.ok(/登録は完了/.test(s), label + ': 登録完了が残っていない: ' + s);
  assert.ok(!/^通信エラー/.test(s), label + ': 通信エラーだけの表示になっている: ' + s);
  assert.ok(/もう一度登録しないでください|もう一度登録せず/.test(s), label + ': 再登録抑止の案内がない: ' + s);
  assert.ok(!/もう一度登録してください/.test(s), label + ': 再登録を促してはいけない');
  assert.deepStrictEqual(Object.keys(env.ctx.adminEntrySelected), [], label + ': 選択日が解除されていない');
  assert.strictEqual(env.ctx.adminEntryBusy, false, label + ': adminEntryBusy が false でない');
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, label + ': 保留が残っている');
  assert.strictEqual(env.submitBtn().disabled, true, label + ': 同じ内容を再送できる状態になっている');
  const creates = env.calls.filter(c => c.params.action === 'adminCreateShift');
  assert.strictEqual(creates.length, 1, label + ': 登録送信は1回だけ');
}

test('22. 登録成功＋再取得TIMEOUT: 登録完了を保持し再登録させない', async () => {
  const env = makeEnv({ existingViaFetch: true, responses: [COMPLETED_OK, { kind: 'hang' }] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assertRegisteredSafely(env, '再取得TIMEOUT');
  assert.ok(/一覧を再取得できませんでした/.test(env.status()), '再取得失敗の説明: ' + env.status());
  assert.ok(/通信タイムアウト/.test(env.status()), '通信エラー種別を補足表示: ' + env.status());
  assert.ok(/画面を開き直して登録済みか確認/.test(env.status()), '確認手段の案内: ' + env.status());
});

test('23. 登録成功＋再取得HTTPエラー: 同じ安全状態になる', async () => {
  const env = makeEnv({ existingViaFetch: true, responses: [COMPLETED_OK, { kind: 'http', status: 502 }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assertRegisteredSafely(env, '再取得HTTP');
  assert.ok(/HTTP 502/.test(env.status()), 'HTTP種別を補足表示: ' + env.status());
});

test('24. 登録成功＋再取得JSON解析エラー: 同じ安全状態になる', async () => {
  const env = makeEnv({ existingViaFetch: true, responses: [COMPLETED_OK, { kind: 'text', text: '<html>err</html>' }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assertRegisteredSafely(env, '再取得PARSE');
  assert.ok(/JSON解析エラー/.test(env.status()), 'JSON解析エラーを補足表示: ' + env.status());
});

test('25. 登録成功＋再取得missing: 通信エラーと誤表示せず不一致を警告', async () => {
  // 再取得は成功するが、保存したIDが含まれない
  const env = makeEnv({ existingViaFetch: true, responses: [COMPLETED_OK, { kind: 'json', json: { ok: true, shifts: [] } }] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assertRegisteredSafely(env, '再取得missing');
  assert.ok(/保存後の再取得結果が一致しませんでした/.test(env.status()), '不一致警告: ' + env.status());
  assert.ok(!/通信エラー|ネットワークエラー|通信タイムアウト/.test(env.status()), '通信エラーと誤表示しない: ' + env.status());
  assert.ok(/操作ID: /.test(env.status()), '操作IDを表示: ' + env.status());
  assert.ok(/管理者へ連絡/.test(env.status()), '連絡先案内: ' + env.status());
});

// ---------------------------------------------------------------- 修正B: 未知応答は安全側
test('26. 未知の結果確認応答: pendingを解除せず「確定できません」と表示', async () => {
  const UNKNOWN = { kind: 'json', json: { ok: false, operationStatus: 'WEIRD_NEW_STATE', errorCode: 'X_UNKNOWN_CODE' } };
  const env = makeEnv({ responses: [{ kind: 'hang' }, UNKNOWN] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(/登録結果を確定できません/.test(env.status()), '確定不能表示: ' + env.status());
  assert.ok(/もう一度登録せず/.test(env.status()), '再登録抑止: ' + env.status());
  assert.ok(env.ctx.adminEntryPendingRequest, 'pendingを解除しない');
  assert.strictEqual(env.recheckBtn().style.display, 'block', '再確認ボタンを維持');
  assert.strictEqual(env.submitBtn().disabled, true, '新規登録できない');
  assert.strictEqual(env.calls.length, 2, '追加の登録送信をしない');
  assert.strictEqual(new Set(env.calls.map(c => c.params.requestId)).size, 1, '新しいrequestIdを作らない');
  assertRecovered(env, '未知応答');
});

test('27. GASロック文言が変わっても失敗確定にせずpendingを維持', async () => {
  // 「他のシフト処理が実行中」を含まない、将来ありうる別文言
  const RENAMED_LOCK = { kind: 'json', json: { ok: false, error: 'Another shift operation is running. Please retry later.' } };
  const env = makeEnv({ responses: [{ kind: 'hang' }, RENAMED_LOCK] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(env.ctx.adminEntryPendingRequest, '文言が変わっても保留を維持する');
  assert.ok(!/失敗として確定/.test(env.status()), '失敗確定にしない: ' + env.status());
  assert.ok(/登録結果を確定できません/.test(env.status()), '確定不能として扱う: ' + env.status());
  assert.strictEqual(env.recheckBtn().style.display, 'block', '再確認ボタンを維持');
  assert.strictEqual(new Set(env.calls.map(c => c.params.requestId)).size, 1, '新しいrequestIdを作らない');
});

// ---------------------------------------------------------------- セッション期限切れ
test('28. セッション期限切れ→再認証: 同じrequestId・同じ内容で再送する', async () => {
  const env = makeEnv({
    noToken: true,
    existingAfterSave: [{ id: 'SH1' }],
    responses: [
      { kind: 'json', json: { ok: true, adminToken: 'TOKEN_A' } },              // 1. セッション作成
      { kind: 'json', json: { ok: false, error: 'セッションの有効期限が切れました。' } }, // 2. 登録→期限切れ
      { kind: 'json', json: { ok: true, adminToken: 'TOKEN_B' } },              // 3. 再認証
      COMPLETED_OK                                                              // 4. 同一paramsで再送
    ]
  });
  await env.ctx.submitAdminShiftEntries();
  await flush();

  const creates = env.calls.filter(c => c.params.action === 'adminCreateShift');
  assert.strictEqual(creates.length, 2, '登録は初回＋再認証後の2回');
  assert.strictEqual(creates[1].params.requestId, creates[0].params.requestId, 'requestIdが同一');
  assert.strictEqual(creates[1].params.shifts, creates[0].params.shifts, 'shifts内容も同一');
  assert.strictEqual(new Set(creates.map(c => c.params.requestId)).size, 1, '新しい登録リクエストを生成しない');
  assert.strictEqual(creates[1].params.adminToken, 'TOKEN_B', '再認証後のトークンで送る');
  assert.ok(/1件を管理者登録しました/.test(env.status()), '最終的に成功として処理: ' + env.status());
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, '成功確定で保留解除');
  assertRecovered(env, 'セッション再認証');
});

test('29. 登録成功＋再取得が未実施(loaded:false): 不一致とは言わない', async () => {
  const env = makeEnv({ notLoaded: true, responses: [COMPLETED_OK] });
  await env.ctx.submitAdminShiftEntries();
  await flush();
  assertRegisteredSafely(env, '再取得未実施');
  assert.ok(/照合は行っていません/.test(env.status()), '照合未実施と明示: ' + env.status());
  assert.ok(!/一致しませんでした/.test(env.status()), '不一致と誤断定しない: ' + env.status());
  assert.ok(!/再取得でも一致しました/.test(env.status()), '一致とも誤断定しない: ' + env.status());
});

test('30. 本番のloadAdminEntryExistingは例外を投げず{ok:false}を返す', async () => {
  // 本番関数そのものを評価し、スタブとの契約一致を保証する（mock乖離の再発防止）。
  const realSrc = slice('async function loadAdminEntryExisting()', 'async function moveAdminEntryMonth');
  const env = makeEnv({ responses: [{ kind: 'hang' }] });
  vm.runInContext(realSrc, env.ctx);      // スタブを本番実装で置き換える
  env.ctx.adminEntryLoadGeneration = 0;
  env.ctx.renderAdminEntryExisting = () => {};

  let settled = null;
  env.ctx.loadAdminEntryExisting().then(v => { settled = v; }, e => { settled = { threw: e }; });
  await flush();
  env.clock.tick(30000);
  await flush();

  assert.ok(settled, '呼出元へ必ず戻る');
  assert.ok(!settled.threw, '例外を投げない（呼出元のcatchに依存しない）: ' + (settled.threw && settled.threw.message));
  assert.strictEqual(settled.ok, false, '失敗を ok:false で返す');
  assert.ok(settled.error && settled.error.gasErrorKind === 'TIMEOUT', 'エラー種別を保持: ' + (settled.error && settled.error.gasErrorKind));
  assert.strictEqual(env.ctx.adminEntryExisting.length, 0, '一覧は空のまま');
});

// ---------------------------------------------------------------- T3実機で判明した表示問題
// 打ち切りの事実が、上書きされて一度も描画されないまま消えないこと。

test('31. TIMEOUT→自動確認COMPLETED: 打ち切りの事実が表示履歴に残る', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, REPLAYED_OK] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;

  const all = env.allStatus();
  // 3. 表示履歴に3要素が残る
  assert.ok(/通信タイムアウト/.test(all), '3. 打ち切りの事実: ' + all);
  assert.ok(/30秒以内に完了しませんでした/.test(all), '3. 30秒であることが分かる: ' + all);
  assert.ok(/同じ操作ID.*で登録結果を確認しています/.test(all), '3. 同じ操作IDで確認中: ' + all);
  assert.ok(/通信はタイムアウトしましたが/.test(env.status()), '3. タイムアウト後に完了確認: ' + env.status());

  // 4. 打ち切りと確認中が「1つのメッセージ」に統合され、単独表示で消えない
  const timeoutOnly = env.statuses.filter(s => /通信タイムアウト/.test(s) && !/確認しています|完了していました/.test(s));
  assert.strictEqual(timeoutOnly.length, 0, '4. 上書きされる単独TIMEOUT表示が残っている: ' + JSON.stringify(timeoutOnly));
  const merged = env.statuses.filter(s => /通信タイムアウト/.test(s) && /確認しています/.test(s));
  assert.strictEqual(merged.length, 1, '4. 統合メッセージが1件であること');
  assert.strictEqual(env.statuses.length, 3, '4. 表示更新は「登録中→統合確認中→結果」の3回: ' + JSON.stringify(env.statuses.map(s => s.split('\n')[0])));

  // 5/6/7. 同一requestIdのみ・POST2回・新規発行なし
  assert.strictEqual(env.calls.length, 2, '6. 登録POSTと確認POSTの2回');
  assert.strictEqual(new Set(env.calls.map(c => c.params.requestId)).size, 1, '5/7. 同一requestIdのみ');
  assert.ok(env.calls.every(c => c.params.action === 'adminCreateShift'), '5. 同じactionで再送');

  // 8. 二重登録を促すUIにならない
  assert.ok(!/もう一度登録してください/.test(all), '8. 再登録を促さない');
  assert.ok(/もう一度登録しないでください/.test(all), '8. 再登録抑止を明示');
  assert.strictEqual(env.ctx.adminEntryPendingRequest, null, '完了確定で保留解除');
  assert.strictEqual(env.submitBtn().disabled, true, '8. 同じ内容を再送できる状態にしない');
  assert.ok(/操作ID: /.test(env.status()), '操作IDを表示');
  assertRecovered(env, 'TIMEOUT→完了確認');
});

test('32. ステータス表示のたび視界へ入れる処理が呼ばれる', async () => {
  const env = makeEnv({ responses: [{ kind: 'hang' }, REPLAYED_OK] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;

  const rv = env.reveals();
  assert.ok(rv.length >= 3, '9. 表示ごとに呼ばれる（3回以上）: ' + rv.length);
  assert.ok(rv.every(r => r.id === 'admin-entry-status'), '9. 対象はステータス要素のみ: ' + JSON.stringify(rv.map(r => r.id)));
  // vmコンテキスト側で生成されるオブジェクトのためプロパティ単位で比較する
  assert.strictEqual(rv[0].arg && rv[0].arg.block, 'nearest', '9. モーダル外を動かさない block:nearest');
  assert.strictEqual(rv[0].arg && rv[0].arg.behavior, 'smooth', '9. behavior:smooth で指定される');
});

test('33. scrollIntoView非対応環境でも例外にならず表示は成立する', async () => {
  const env = makeEnv({ noScrollIntoView: true, responses: [{ kind: 'hang' }, REPLAYED_OK] });
  assert.strictEqual(typeof env.doc.getElementById('admin-entry-status').scrollIntoView, 'undefined', '非対応環境である');
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(/通信はタイムアウトしましたが/.test(env.status()), '10. 表示は成立する: ' + env.status());
  assert.strictEqual(env.reveals().length, 0, '10. 視界移動は行われない');
  assertRecovered(env, 'scrollIntoView非対応');
});

test('34. scrollIntoViewが例外を投げても処理が継続する', async () => {
  const env = makeEnv({ scrollThrows: true, responses: [{ kind: 'hang' }, REPLAYED_OK] });
  const p = env.ctx.submitAdminShiftEntries();
  await flush();
  env.clock.tick(30000);
  await flush();
  await p;
  assert.ok(/通信はタイムアウトしましたが/.test(env.status()), '10. 例外を吸収して表示は成立: ' + env.status());
  assertRecovered(env, 'scrollIntoView例外');
});

test('35. TIMEOUT→確認が処理中/確認もTIMEOUT: 打ち切りを残しpendingと再確認ボタンを維持', async () => {
  // 11. IN_PROGRESS
  const busy = makeEnv({ responses: [{ kind: 'hang' },
    { kind: 'json', json: { ok: false, error: '他のシフト処理が実行中です。完了後にもう一度お試しください。' } }] });
  let p = busy.ctx.submitAdminShiftEntries();
  await flush(); busy.clock.tick(30000); await flush(); await p;
  assert.ok(/通信タイムアウト/.test(busy.allStatus()), '11. 打ち切りの事実が残る');
  assert.ok(/まだ処理中/.test(busy.status()), '11. 処理中表示: ' + busy.status());
  assert.ok(busy.ctx.adminEntryPendingRequest, '11. pending保持');
  assert.strictEqual(busy.recheckBtn().style.display, 'block', '11. 再確認ボタン表示');
  assert.strictEqual(busy.submitBtn().disabled, true, '11. 新規登録できない');
  assert.strictEqual(new Set(busy.calls.map(c => c.params.requestId)).size, 1, '11. 同一requestId');

  // 12. 結果確認もTIMEOUT
  const both = makeEnv({ responses: [{ kind: 'hang' }, { kind: 'hang' }] });
  p = both.ctx.submitAdminShiftEntries();
  await flush(); both.clock.tick(30000); await flush(); both.clock.tick(30000); await flush(); await p;
  assert.ok(/通信タイムアウト/.test(both.allStatus()), '12. 打ち切りの事実が残る');
  assert.ok(/登録結果不明/.test(both.status()), '12. 結果不明表示: ' + both.status());
  assert.ok(both.ctx.adminEntryPendingRequest, '12. pending保持');
  assert.strictEqual(both.recheckBtn().style.display, 'block', '12. 再確認ボタン表示');
  assert.strictEqual(new Set(both.calls.map(c => c.params.requestId)).size, 1, '12. 同一requestId');
});

// 画面が戻らない不具合をテスト側でも検出する。実時間5秒で打ち切る。
function guard(promise, name) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('テストが完了しません（画面が戻らない可能性）: ' + name)), 5000);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

(async function run() {
  for (const t of queue) {
    try { await guard(t.fn(), t.name); passed++; process.stdout.write('ok ' + passed + ' - ' + t.name + '\n'); }
    catch (e) { process.stderr.write('not ok - ' + t.name + '\n' + e.stack + '\n'); process.exitCode = 1; }
  }
  process.stdout.write('# passed ' + passed + '/' + queue.length + '\n');
})();
