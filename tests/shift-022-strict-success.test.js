'use strict';
// SHIFT-022: 管理者操作の成功判定を厳格化したことの検証。
// COMPENSATED / FAILED / NEEDS_REVIEW / FINAL_STATE_MISMATCH は成功扱いしない。
const fs=require('fs');const path=require('path');const assert=require('assert');const vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let passed=0;
function test(name,fn){try{fn();passed++;process.stdout.write('ok '+passed+' - '+name+'\n');}
catch(e){process.stderr.write('not ok - '+name+'\n'+e.stack+'\n');process.exitCode=1;}}

// 判定関数群を切り出して評価する
// 判定関数群 + 失敗メッセージ組み立て（adminShiftFailureDetail を含む範囲）を評価する
const src=html.slice(html.indexOf('const ADMIN_OP_BAD_STATUSES'),html.indexOf('async function submitAdminShiftEntries'))
  + '\n' + html.slice(html.indexOf('function adminShiftFailureDetail'),html.indexOf('function adminShiftFailureMessage'));
const ctx={adminEntryStaff:{id:'PT016',name:'中山　佳男'}};
vm.createContext(ctx);vm.runInContext(src,ctx);
const ok=(saved,errors,extra)=>Object.assign({ok:true,saved,errors:errors||[]},extra||{});
const COMPLETED=(id)=>({id:id,operationStatus:'COMPLETED',year:2026,month:9,day:15});

test('1. 単日COMPLETEDだけ成功',()=>{
  const d=ok([COMPLETED('S1')],[]);
  assert.doesNotThrow(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('2. 単日COMPENSATEDは失敗',()=>{
  const d={ok:false,saved:[],errors:[{date:'2026-09-15',operationStatus:'COMPENSATED',errorCode:'FINAL_STATE_MISMATCH',operationId:'A1'}]};
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('3. 単日FAILEDは失敗',()=>{
  const d=ok([],[{date:'2026-09-15',operationStatus:'FAILED',errorCode:'SHEET_CREATE_FAILED'}]);
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('4. 単日NEEDS_REVIEWは失敗',()=>{
  const d=ok([],[{date:'2026-09-15',operationStatus:'NEEDS_REVIEW'}],{needsReview:true});
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('5. 複数日の全件COMPLETEDは成功',()=>{
  const d=ok([COMPLETED('S1'),COMPLETED('S2')],[]);
  assert.doesNotThrow(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('6. 複数日の一部COMPENSATEDは成功表示しない（本件の確定バグ）',()=>{
  const d=ok([COMPLETED('S1')],[{date:'2026-09-16',operationStatus:'COMPENSATED',errorCode:'FINAL_STATE_MISMATCH',operationId:'A2'}]);
  assert.strictEqual(d.ok,true,'GASはok:trueを返す');
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'),'UIが成功扱いしてはいけない');
});
test('7. 複数日の一部FAILEDは成功表示しない',()=>{
  const d=ok([COMPLETED('S1')],[{date:'2026-09-16',operationStatus:'FAILED'}]);
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('8. 複数日の一部NEEDS_REVIEWは成功表示しない',()=>{
  const d=ok([COMPLETED('S1')],[{date:'2026-09-16',operationStatus:'NEEDS_REVIEW'}]);
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('9. saved.length>0だけでは成功にならない（状態が無い応答）',()=>{
  const d=ok([{id:'S1'}],[]);   // operationStatus が無い
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('10. HTTP200相当でも ok:false は失敗',()=>{
  assert.throws(()=>ctx.assertAdminShiftSuccess({ok:false,saved:[],errors:[]},'x'));
});
test('11. FINAL_STATE_MISMATCHは失敗',()=>{
  const d=ok([COMPLETED('S1')],[{date:'2026-09-16',errorCode:'FINAL_STATE_MISMATCH'}]);
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('12. errorsが1件でもあれば成功にしない',()=>{
  const d=ok([COMPLETED('S1')],[{date:'2026-09-16',error:'なんらかの失敗'}]);
  assert.throws(()=>ctx.assertAdminShiftSuccess(d,'x'));
});
test('13. COMPENSATEDの文言が指定どおり',()=>{
  assert.ok(/登録できませんでした。作成途中のデータは自動的に元へ戻しました。/.test(html));
  assert.ok(/再登録せず、管理者へ連絡してください。/.test(html));
});
test('14. 失敗詳細に operationId・エラーコード・対象スタッフ・対象日',()=>{
  const d={errors:[{date:'2026-09-15',operationId:'A1',errorCode:'FINAL_STATE_MISMATCH'}]};
  const s=ctx.adminShiftFailureDetail(d,'A1785804670699_auu7o82w','FINAL_STATE_MISMATCH');
  assert.ok(s.includes('操作ID: A1785804670699_auu7o82w'));
  assert.ok(s.includes('エラーコード: FINAL_STATE_MISMATCH'));
  assert.ok(s.includes('中山　佳男（PT016）'));
  assert.ok(s.includes('対象日: 2026-09-15'));
});
test('15. 成功日・失敗日を個別表示する',()=>{
  assert.ok(/【保存された日】/.test(html));
  assert.ok(/【失敗した日】/.test(html));
  assert.ok(/登録できた日: /.test(html));
});
test('16. 自動再送しない・requestIdを再利用しない',()=>{
  assert.ok(!/adminShiftGet\(params, ?true\)[\s\S]{0,200}adminCreateShift/.test(html),'CREATEの自動再送なし');
  const n=(html.match(/const requestId=adminRequestId\(\)/g)||[]).length;
  assert.ok(n>=1,'操作ごとにrequestIdを新規生成');
});
test('17. 成功トーストは partial 表示に依存しない',()=>{
  assert.ok(!/showAdminEntryStatus\([^)]*data\.partial/.test(html),'partialで成功トーストを出す実装が残っている');
});
test('18. UPDATE/DELETEも同じ判定を通る',()=>{
  assert.ok(/assertAdminShiftSuccess\(data,'変更できませんでした。'\)/.test(html));
  assert.ok(/assertAdminShiftSuccess\(data,'削除できませんでした。'\)/.test(html));
});
