'use strict';
// SHIFT-022: 管理者シフト登録の時刻入力が select（30分刻み）であることの検証。
// iPhone/iPadで text+inputmode=numeric だと「:」を入力できないための修正。
const fs=require('fs');const path=require('path');const assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let passed=0;
function test(name,fn){try{fn();passed++;process.stdout.write('ok '+passed+' - '+name+'\n');}
catch(e){process.stderr.write('not ok - '+name+'\n'+e.stack+'\n');process.exitCode=1;}}

// 管理者UIブロック（他画面への影響を除外して検査する）
const adminBlock=html.slice(html.indexOf('// SHIFT-022 管理者専用'),
  html.indexOf('// ============================================================\n// ① 申請タブ'));

// ヘルパ群をvmで評価して実際の生成結果を検査する
const vm=require('vm');
const helperSrc=html.slice(html.indexOf('const ADMIN_TIME_STEP_MIN'),html.indexOf('function pickAdminShiftTimes_'));
const ctx={FLEX_END_LABEL:'状況次第',dispT:(t)=>t,document:{createElement:()=>({appendChild(){},querySelector(){return null},set value(v){this._v=v},get value(){return this._v}})}};
vm.createContext(ctx);vm.runInContext(helperSrc,ctx);

test('1. 新規/複数日の時刻入力が select である',()=>{
  // 実装は種別を三項演算子で渡す: createAdminShiftTimeSelect_(v[2]==='start'?'start':'end', ...)
  assert.ok(/createAdminShiftTimeSelect_\(/.test(adminBlock),'selectを生成していない');
  assert.ok(/'start'\s*:\s*'end'/.test(adminBlock),'開始/終了の種別を渡していない');
  assert.ok(!/createElement\('input'\)/.test(adminBlock),'管理者UIにinput要素が残っている');
});
test('2. 数字キーボード入力に依存しない（inputMode=numeric を使わない）',()=>{
  assert.ok(!/inputMode\s*=\s*'numeric'/.test(adminBlock),'管理者UIにnumericが残っている');
});
test('3. 時刻をpromptで入力させない',()=>{
  assert.ok(!/prompt\('開始時間/.test(html));
  assert.ok(!/prompt\('終了時間/.test(html));
});
test('4. 開始の選択肢が30分刻み',()=>{
  const v=ctx.adminShiftTimeValues_('start');
  assert.equal(v[0],'00:00');assert.equal(v[1],'00:30');assert.equal(v[2],'01:00');
  assert.equal(v.length,48,'0:00-23:30 の48件');
});
test('5. 17:00 を選択できる',()=>assert.ok(ctx.adminShiftTimeValues_('start').includes('17:00')));
test('6. 22:00 を選択できる',()=>assert.ok(ctx.adminShiftTimeValues_('end').includes('22:00')));
test('7. 24:00 を終了に選択できる（既存有効値）',()=>assert.ok(ctx.adminShiftTimeValues_('end').includes('24:00')));
test('8. 終了の最大は 29:30（GAS parseShiftMinutes_ の allowExtended と一致）',()=>{
  const v=ctx.adminShiftTimeValues_('end');
  assert.equal(v[v.length-1],'29:30');assert.equal(v.length,60);
});
test('9. 開始の最大は 23:30（終了だけ延長を許す）',()=>{
  const v=ctx.adminShiftTimeValues_('start');
  assert.equal(v[v.length-1],'23:30');
  assert.ok(!v.includes('24:00'),'開始に24:00を出さない');
});
test('10. 最小時刻 00:00 を両方で選択できる',()=>{
  assert.ok(ctx.adminShiftTimeValues_('start').includes('00:00'));
  assert.ok(ctx.adminShiftTimeValues_('end').includes('00:00'));
});
test('11. 終了に「状況次第」を選択できる',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','');
  assert.ok(o.some(x=>x.value==='状況次第'));
});
test('12. 開始には「状況次第」を出さない',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('start','');
  assert.ok(!o.some(x=>x.value==='状況次第'));
});
test('13. 30分刻みでない保存済み値も選択肢に含める（既存データを編集不能にしない）',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('start','17:15');
  assert.ok(o.some(x=>x.value==='17:15'));
});
test('14. 選択肢は時刻順に並ぶ',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','17:15').filter(x=>x.value!=='状況次第');
  const k=o.map(x=>ctx.adminTimeSortKey_(x.value));
  assert.deepEqual(k,k.slice().sort((a,b)=>a-b));
});
test('15. 値と表示が同じ形式（タイムゾーン変換をしない）',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('start','');
  o.slice(0,5).forEach(x=>assert.equal(x.label,x.value));
});
test('16. 未選択（空）を先頭に置く',()=>{
  assert.ok(/ph\.value\s*=\s*''/.test(html)&&/時刻を選択/.test(html));
});
test('17. 未選択・出勤=退勤を拒否する',()=>{
  assert.ok(/出勤時刻を選択してください/.test(html));
  assert.ok(/退勤時刻を選択してください/.test(html));
  assert.ok(/出勤と退勤に同じ時刻は指定できません/.test(html));
});
test('18. 送信payloadの形式が従来と同一（action・引数名を変えない）',()=>{
  assert.ok(/action:'adminCreateShift',targetStaffId:.*storeId:.*shifts:JSON\.stringify\(items\),requestId/.test(adminBlock));
  assert.ok(/action:'adminUpdateShift',id:shift\.id,.*start:start,end:/.test(adminBlock));
});
test('19. 日ごとに独立した値を持つ（selectのonChangeが該当日だけ更新）',()=>{
  assert.ok(/function\(val\)\{s\[v\[2\]\]=val;delete s\.error/.test(adminBlock));
});
test('20. 処理中はselectを操作できない（二重送信防止の維持）',()=>{
  assert.ok(/sel\.disabled=adminEntryBusy/.test(adminBlock));
});
test('21. 編集時に保存済み値が選択される',()=>{
  assert.ok(/pickAdminShiftTimes_\(shift\.start,shift\.end\)/.test(adminBlock));
  assert.ok(/createAdminShiftTimeSelect_\('start',curStart\)/.test(html));
  assert.ok(/createAdminShiftTimeSelect_\('end',curEnd\)/.test(html));
});
test('22. 本人申請UIのプリセットボタンを変更していない',()=>{
  assert.ok(/function startPresetsFor/.test(html));
  assert.ok(/function endPresetsFor/.test(html));
  assert.ok(/id="start-custom"/.test(html)&&/id="end-custom"/.test(html));
});
test('23. タップ領域を確保している（min-height 44px）',()=>{
  assert.ok(/\.admin-time-select\{[^}]*min-height:44px/.test(html));
});
