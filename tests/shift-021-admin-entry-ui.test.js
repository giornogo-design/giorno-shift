'use strict';
const fs=require('fs');const path=require('path');const assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let passed=0;
function test(name,fn){try{fn();passed++;process.stdout.write('ok '+passed+' - '+name+'\n');}catch(e){process.stderr.write('not ok - '+name+'\n'+e.stack+'\n');process.exitCode=1;}}

test('正式名称はスタッフのシフト登録',()=>assert(html.includes('スタッフのシフト登録')));
test('空日から独立した起動ボタンがある',()=>assert(/id="admin-shift-entry-open"/.test(html)));
test('店舗選択欄がある',()=>assert(/id="admin-entry-store"/.test(html)));
test('検索可能なスタッフ入力がある',()=>assert(/id="admin-entry-search"[^>]+type="search"/.test(html)));
test('スタッフIDを候補表示する',()=>assert(html.includes("s.name+'（'+s.id+'）'")));
test('所属店舗を候補表示する',()=>assert(html.includes("'所属: '")));
test('在籍スタッフAPIを使う',()=>assert(html.includes("action:'adminGetStaffForShiftEntry'")));
test('年月を独立して保持する',()=>assert(html.includes('adminEntryYear')&&html.includes('adminEntryMonth')));
test('ISO年付きキーで日付を分離する',()=>assert(html.includes("year+'-'+String(month).padStart")));
test('複数日をオブジェクトで保持する',()=>assert(html.includes('adminEntrySelected[key]')));
test('日ごとの開始終了入力がある',()=>assert(html.includes("['開始',s.start,'start']")&&html.includes("['終了',s.end,'end']")));
test('登録前確認がある',()=>assert(html.includes('次の内容を管理者登録します')));
test('二重送信防止requestIdを送る',()=>assert(html.includes("requestId=adminRequestId()")||html.includes('requestId});')));
test('管理者専用APIを呼ぶ',()=>assert(html.includes("action:'adminCreateShift'")));
test('旧proxyShiftを新UIから呼ばない',()=>{
  const block=html.slice(html.indexOf('// SHIFT-021 管理者専用'),html.indexOf('// ============================================================\n// ① 申請タブ'));
  assert(!block.includes("action:'proxyShift'"));
});
test('保存後に再取得してID一致を確認する',()=>assert(html.includes('missing=(data.saved||[]).filter')));
test('部分成功を画面で区別する',()=>assert(html.includes('data.partial')));
test('編集時の日付変更でも明示年を送る',()=>assert(html.includes('year:newYear,month:newMonth,day:newDay')));
test('作成中は追加操作を禁止する',()=>assert(html.includes('adminEntryBusy=true')));
test('管理者登録と本人申請を表示で区別する',()=>assert(html.includes("s.source==='ADMIN'?'管理者登録':'本人申請'")));
test('管理者認証はLINE資格情報からセッション化する',()=>assert(html.includes('adminCreateShiftSession')&&html.includes('liff.getIDToken')));
test('認証情報と管理者tokenはPOST本文で送る',()=>assert(html.includes('async function gasPost')&&html.includes("transport:'adminShift'")&&html.includes('await gasPost')));
test('新UIの管理者APIへlineIdを送らない',()=>{
  const block=html.slice(html.indexOf('// SHIFT-021 管理者専用'),html.indexOf('// ============================================================\n// ① 申請タブ'));
  assert(!/adminShiftGet\(\{[^}]*lineId/.test(block));
});
test('外部UIライブラリを追加していない',()=>assert(!/(select2|choices\.js|react|vue|bootstrap)/i.test(html)));
test('一般スタッフは管理者タブへ遷移できない',()=>assert(html.includes("if (ADMIN_TABS.includes(tab) && !(staffData && staffData.isAdmin)) return")));
test('既存の本人申請年送信を維持する',()=>assert(html.includes("action:'saveShift', lineId, storeId:applyStore.id, shifts:JSON.stringify(items)")));
test('LINE通知を登録確認文で明示的に行わない',()=>assert(html.includes('確定・LINE通知は行いません')));

if(!process.exitCode)process.stdout.write('PASS '+passed+' tests\n');
