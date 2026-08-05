'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let passed=0;function test(name,fn){try{fn();passed++;process.stdout.write('ok '+passed+' - '+name+'\n');}catch(e){process.stderr.write('not ok - '+name+'\n'+e.stack+'\n');process.exitCode=1;}}

test('needsReviewを手動確認必要として表示する',()=>assert(html.includes("status==='NEEDS_REVIEW'")&&html.includes('操作は完了していない可能性があります')));
test('補償済みを失敗として表示し自動復旧を明示する',()=>assert(html.includes("status==='COMPENSATED'")&&html.includes('登録できませんでした。作成途中のデータは自動的に元へ戻しました。')&&html.includes('再登録せず、管理者へ連絡してください。')));
test('重大エラーへ操作IDと再操作禁止を表示する',()=>assert(html.includes("操作ID: '+(operationId")&&html.includes('同じ操作を繰り返さないでください')));
test('ok falseとCOMPENSATED/FAILED/NEEDS_REVIEWを成功扱いしない',()=>assert(html.includes('data.ok!==true')&&html.includes("ADMIN_OP_BAD_STATUSES = ['COMPENSATED','FAILED','NEEDS_REVIEW']")&&html.includes('adminShiftAllCompleted')));
test('古い再取得レスポンスを世代番号で破棄する',()=>assert(html.includes('adminEntryLoadGeneration')&&html.includes('generation!==adminEntryLoadGeneration')));
test('二重操作防止と操作後再取得を維持する',()=>assert(html.includes('if(adminEntryBusy')&&html.includes('adminEntryBusy=true')&&html.includes('await loadAdminEntryExisting()')));

if(!process.exitCode)process.stdout.write('PASS '+passed+' tests\n');
