'use strict';
// SHIFT-022: 管理者UIの表記を「出勤／退勤」へ、退勤に「ラスト」を追加したことの検証。
// 「ラスト」は本人申請と同じく店舗別の実時刻を保存する（「状況次第」とは保存値が異なり区別できる）。
const fs=require('fs');const path=require('path');const assert=require('assert');const vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let passed=0;
function test(name,fn){try{fn();passed++;process.stdout.write('ok '+passed+' - '+name+'\n');}
catch(e){process.stderr.write('not ok - '+name+'\n'+e.stack+'\n');process.exitCode=1;}}

const adminHtml=html.slice(html.indexOf('<!-- SHIFT-022 管理者専用'),html.indexOf('<!-- 旧入力画面（後方互換用'));
const adminJs=html.slice(html.indexOf('// SHIFT-022 管理者専用'),
  html.indexOf('// ============================================================\n// ① 申請タブ'));
const personalHtml=html.slice(html.indexOf('<!-- 旧入力画面（後方互換用'));

const ctx={FLEX_END_LABEL:'状況次第',dispT:(t)=>t,
  STORE_LAST:{S001:'28:00',S002:'25:00',S003:'23:30'},
  STORE_CLOSE:{S001:'04:00',S002:'01:00',S003:'23:00'}};
vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('const ADMIN_TIME_STEP_MIN'),html.indexOf('function createAdminShiftTimeSelect_')),ctx);

test('1. 管理者UIに「開始」表示が残っていない',()=>{
  assert.ok(!/▶ 開始時間/.test(adminHtml),'HTMLに開始が残存');
  assert.ok(!/'開始/.test(adminJs),'JSに開始が残存');
});
test('2. 管理者UIに「終了」表示が残っていない',()=>{
  assert.ok(!/▶ 終了時間/.test(adminHtml));
  assert.ok(!/'終了/.test(adminJs));
});
test('3. 「出勤」が表示される',()=>{
  assert.ok(/▶ 出勤時間/.test(adminHtml));
  assert.ok(/'出勤'/.test(adminJs));
});
test('4. 「退勤」が表示される',()=>{
  assert.ok(/▶ 退勤時間/.test(adminHtml));
  assert.ok(/'退勤'/.test(adminJs));
});
test('5. 退勤に「状況次第」が残る',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','','S003');
  assert.ok(o.some(x=>x.value==='状況次第'&&x.label==='状況次第'));
});
test('6. 退勤に「ラスト」が追加される',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','','S003');
  assert.ok(o.some(x=>/^ラスト（/.test(x.label)),'ラストの選択肢がない');
});
test('7. 出勤には「ラスト」を表示しない',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('start','','S003');
  assert.ok(!o.some(x=>/ラスト/.test(x.label)));
});
test('8. 出勤には「状況次第」を表示しない',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('start','','S003');
  assert.ok(!o.some(x=>x.value==='状況次第'));
});
test('9. 通常時刻のpayloadは従来どおり（17:00形式）',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','','S003');
  assert.ok(o.some(x=>x.value==='22:00'&&x.label==='22:00'));
});
test('10. ラストの保存値は店舗別の実時刻（本人申請と同一）',()=>{
  assert.equal(ctx.adminShiftLastValue_('S001'),'28:00');
  assert.equal(ctx.adminShiftLastValue_('S002'),'25:00');
  assert.equal(ctx.adminShiftLastValue_('S003'),'23:30');
});
test('11. 「状況次第」と「ラスト」は保存値が異なり区別できる',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','','S003');
  const flex=o.find(x=>x.value==='状況次第');
  const last=o.find(x=>/^ラスト（/.test(x.label));
  assert.notEqual(flex.value,last.value,'同じ値だと後から区別できない');
  assert.equal(last.value,'23:30');
});
test('12. ラストを29:30や24:00へ無断変換していない',()=>{
  assert.notEqual(ctx.adminShiftLastValue_('S003'),'29:30');
  assert.notEqual(ctx.adminShiftLastValue_('S003'),'24:00');
});
test('13. 新規登録の初期値は従来どおりSTORE_LAST',()=>{
  assert.ok(/end:STORE_LAST\[adminEntryStore\.id\]/.test(adminJs));
});
test('14. 複数日でも日ごとに退勤値を選べる',()=>{
  assert.ok(/\[\['出勤',s\.start,'start'\],\['退勤',s\.end,'end'\]\]/.test(adminJs));
  assert.ok(/function\(val\)\{s\[v\[2\]\]=val/.test(adminJs));
});
test('15. 編集時に保存済み値が復元される（storeIdも渡す）',()=>{
  assert.ok(/pickAdminShiftTimes_\(shift\.start,shift\.end\)/.test(adminJs));
  assert.ok(/createAdminShiftTimeSelect_\('end',curEnd/.test(html));
});
test('16. 編集時に保存済みラスト値が選択肢に含まれる',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','23:30','S003');
  assert.ok(o.some(x=>x.value==='23:30'));
});
test('17. 編集時に保存済み「状況次第」が選択肢に含まれる',()=>{
  const o=ctx.buildAdminShiftTimeOptions_('end','状況次第','S003');
  assert.ok(o.some(x=>x.value==='状況次第'));
});
test('18. 確認表示が「出勤 …／退勤 …」形式',()=>{
  assert.ok(/出勤 '\+s\.start\+'／退勤 '\+dispEnd/.test(adminJs),'登録確認');
  assert.ok(/出勤 '\+start\+'／退勤 '\+dispEnd\(start,end\)\+' に変更しますか？'/.test(adminJs),'編集確認');
  assert.ok(/出勤 '\+shift\.start\+'／退勤 '\+dispEnd/.test(adminJs),'削除確認');
});
test('19. APIの引数名 start/end は変更していない',()=>{
  assert.ok(/action:'adminCreateShift',targetStaffId:.*shifts:JSON\.stringify\(items\),requestId/.test(adminJs));
  assert.ok(/start:start,end:/.test(adminJs));
});
test('20. 本人申請UIの表記・プリセットは無変更',()=>{
  assert.ok(/▶ 開始時間/.test(personalHtml),'本人申請の開始時間が消えている');
  assert.ok(/▶ 終了時間/.test(personalHtml),'本人申請の終了時間が消えている');
  assert.ok(/function endPresetsFor/.test(html));
  assert.ok(/label:'ラスト', value: STORE_LAST\[storeId\]/.test(html),'本人申請のラスト定義が変わっている');
});
test('21. 削除処理・整合性確認のAPIは変更していない',()=>{
  assert.ok(/action:'adminDeleteShift'/.test(adminJs));
  assert.ok(/action:'adminGetShiftEntries'/.test(adminJs));
});
