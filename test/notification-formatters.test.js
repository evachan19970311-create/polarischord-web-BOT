"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {buildScoreEmbed,buildQapRecordEmbed,dateTime}=require("../notification-formatters");
const record={music_title:"金木犀",diff:"inf",display_date:"2026/11/06",members:[
  {member_index:0,name:"確認プレイヤーA",crewid:"-"},
  {member_index:1,name:"確認プレイヤーB",crewid:"11111111"},
  {member_index:2,name:"確認プレイヤーC",crewid:"22222222"},
  {member_index:3,name:"確認プレイヤーD（・ω・",crewid:"33333333"},
]};
const log={id:292,admin_display_name:"確認管理者",admin_id:"u_private_admin",created_at:"2026-11-06T14:58:13Z",success:true};
const values=embed=>Object.fromEntries(embed.fields.map(f=>[f.name,f.value]));

test("PolaQ addition uses the supplied record and keeps account name, execution time and logid at the bottom",()=>{
  const embed=buildQapRecordEmbed({log:{...log,action:"qap_record_create",after_data:record}}).toJSON();
  const f=values(embed);
  assert.equal(embed.title,"🆕 PolaQ｜QAPデータ追加");
  assert.equal(f["楽曲名"],"金木犀");assert.equal(f["難易度"],"INF");assert.equal(f["達成日時"],"2026/11/06");
  assert.equal(f["プレイヤー"].split("\n").length,4);
  assert.match(f["プレイヤー"],/^1\. 確認プレイヤーA（Crew ID：未登録）/);
  assert.match(f["操作情報"],/管理アカウント：確認管理者\n実行日時：2026\/11\/06 23:58:13\nlogid：292/);
  assert.equal(embed.fields.at(-1).name,"操作情報");
  assert.doesNotMatch(JSON.stringify(embed),/u_private_admin|admin_id|before_data|Supabase|GitHub/);
  assert.equal(embed.timestamp,undefined);
});
test("PolaQ edit reports only changed values and normalizes equivalent difficulty and date formats",()=>{
  const after={...record,diff:"INFLUENCE",display_date:"2026-11-07",members:record.members.map((m,i)=>i===0?{...m,crewid:"12345678"}:m)};
  const embed=buildQapRecordEmbed({log:{...log,action:"qap_record_update",before_data:record,after_data:after}}).toJSON();
  const f=values(embed);
  assert.equal(embed.title,"✏️ PolaQ｜QAPデータ編集");
  assert.match(f["変更内容"],/達成日時：2026\/11\/06 → 2026\/11\/07/);
  assert.match(f["変更内容"],/プレイヤー：/);
  assert.doesNotMatch(f["変更内容"],/難易度：|楽曲名：/);
  const changed=values(buildQapRecordEmbed({log:{...log,action:"qap_record_update",before_data:record,after_data:{...record,music_title:"別の楽曲",diff:"POLAR"}}}).toJSON());
  assert.match(changed["変更内容"],/楽曲名：金木犀 → 別の楽曲/);assert.match(changed["変更内容"],/難易度：INF → POLAR/);
});
test("deleted records use the saved before state and failed edits are never presented as successful",()=>{
  const deleted=buildQapRecordEmbed({log:{...log,action:"qap_record_delete",before_data:record}}).toJSON();
  assert.equal(deleted.title,"🗑️ PolaQ｜QAPデータ削除");assert.equal(values(deleted)["楽曲名"],"金木犀");
  const failure=buildQapRecordEmbed({log:{...log,success:false,action:"qap_record_update",before_data:record,error_message:"保存できませんでした",detail:{error_code:"SAVE_FAILED"}}}).toJSON();
  assert.equal(failure.title,"❌ PolaQ｜編集エラー");assert.equal(values(failure)["変更内容"],undefined);
  assert.match(values(failure)["調査用情報"],/処理箇所：QAPデータの編集\nエラーコード：SAVE_FAILED/);
});
test("legacy events and errors without a record remain readable without inventing admin or achievement data",()=>{
  const legacy=values(buildQapRecordEmbed({record,admin_display_name:"管理者",log_id:42,executed_at:"2026/11/06 23:58:13"},"create").toJSON());
  assert.match(legacy["操作情報"],/23:58:13\nlogid：42/);
  const error=buildQapRecordEmbed({stage:"notify_qap_admin_activity",payload:{log_id:292,access_token:"never-print-this"},error_message:"通知できませんでした"},"error").toJSON();
  assert.match(values(error)["操作情報"],/管理アカウント：取得できませんでした/);
  assert.match(values(error)["操作情報"],/logid：292/);
  assert.match(values(error)["記録情報"],/取得できませんでした/);
  assert.doesNotMatch(JSON.stringify(error),/never-print-this|access_token/);
});
test("PolaBase includes requested information and moves error diagnostics to the bottom",()=>{
  const payload={is_initial:true,player_name:"プレイヤー",crew_id:"32474862",public_id:"u_private",exported_at:"2026-11-06T14:58:13Z",music_count:50,score_count:80,snapshot_id:"hidden",stage_label:"スコアの保存",error_code:"SCORE_IMPORT_FAILED",error_message:"スコアを保存できませんでした。"};
  const added=buildScoreEmbed(payload).toJSON();
  assert.equal(added.title,"🆕 PolaBase｜新規登録");
  assert.deepEqual(added.fields.map(f=>f.name),["プレイヤー","Crew ID","登録日時"]);
  const error=buildScoreEmbed(payload,true).toJSON();
  assert.equal(error.title,"❌ PolaBase｜スコア登録エラー");
  assert.equal(error.fields.at(-1).name,"調査用情報");
  assert.doesNotMatch(JSON.stringify(error),/u_private|Public ID|snapshot|保存先/);
  assert.equal(values(buildScoreEmbed({},true).toJSON())["プレイヤー情報"],"取得できませんでした");
});
test("date-only, JST local and offset timestamps retain their actual precision and zone",()=>{
  assert.equal(dateTime("2026-11-06"),"2026/11/06");
  assert.equal(dateTime("2026/11/06 23:58:13"),"2026/11/06 23:58:13");
  assert.equal(dateTime("2026-11-06T14:58:13Z"),"2026/11/06 23:58:13");
  assert.equal(dateTime("2026-11-06T23:58:13+09:00"),"2026/11/06 23:58:13");
  assert.equal(dateTime(null),"取得できませんでした");
  assert.equal(dateTime("invalid"),"取得できませんでした");
});
test("large fields and missing members stay within Discord limits without broken surrogate pairs",()=>{
  const large={...record,music_title:"😀".repeat(2000),members:[null,...record.members.map(m=>({...m,name:"😀".repeat(1000)}))]};
  const data=buildQapRecordEmbed({log:{...log,action:"qap_record_update",before_data:record,after_data:large}}).toJSON();
  let length=data.title.length+data.footer.text.length;
  for(const f of data.fields){assert.ok(f.value.length<=1024);assert.doesNotMatch(f.value,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);length+=f.name.length+f.value.length;}
  assert.ok(length<6000);
});
