"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createNotificationDeduplicator } = require("../notification-dedup");

test("concurrent retries and completed retries send once; failures remain retryable", async () => {
  let now=0, count=0, finish;
  const once=createNotificationDeduplicator({now:()=>now,ttlMs:100});
  const job=()=>{count++;return new Promise(resolve=>{finish=resolve;});};
  const a=once('same',job),b=once('same',job);
  await Promise.resolve();assert.equal(count,1);finish({ok:true});
  assert.deepEqual(await a,await b);
  await once('same',job);assert.equal(count,1);
  now=101;const next=once('same',job);await Promise.resolve();finish({ok:true});await next;assert.equal(count,2);
  await assert.rejects(once('failure',()=>{throw Error('failed');}));
  assert.equal(await once('failure',()=>42),42);
});
test("pending jobs stay bounded and settled cache entries can be evicted", async () => {
  const once=createNotificationDeduplicator({maxEntries:1});
  let finish; const a=once('a',()=>new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve();await assert.rejects(once('b',()=>1),/busy/);
  finish(0);await a;assert.equal(await once('b',()=>1),1);
});

test("real notify route authenticates, routes channels, validates embeds and deduplicates without logging into Discord", async t => {
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8').replace(/start\(\)\.catch\([\s\S]*$/, '')+'\nmodule.exports={app,client};';
  const module={exports:{}};
  vm.runInNewContext(source,{
    require:createRequire(require.resolve('../index.js')),module,Buffer,setTimeout,Date,
    process:{env:{DISCORD_BOT_TOKEN:'fixture-bot',DISCORD_NOTIFY_API_TOKEN:'fixture-api-token',DISCORD_CHANNEL_SCORE_LOG:'new-channel',DISCORD_CHANNEL_SCORE_ERROR_LOG:'error-channel',DISCORD_CHANNEL_QAP_LOG:'qap-channel',DISCORD_CHANNEL_QAP_ERROR_LOG:'qap-error-channel',RENDER_GIT_COMMIT:'fixture-revision'}},
    console:{log(){},error(){}},
  });
  const {app,client}=module.exports;
  const messages=[];
  client.isReady=()=>true;
  client.channels.fetch=async id=>({isTextBased:()=>true,send:async options=>{
    messages.push({id,options,embed:options.embeds[0].toJSON()});return{id:'message-'+messages.length};
  }});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();client.destroy();});
  const origin='http://127.0.0.1:'+server.address().port;
  const post=(body,token='fixture-api-token')=>fetch(origin+'/notify',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const payload={source:'score_tool',event_type:'bookmarklet',level:'info',is_initial:true,event_id:'new-1',player_name:'@everyone',music_count:1,score_count:2,exported_at:'2026-11-06T13:00:00Z'};
  assert.equal((await post(payload,'wrong')).status,401);
  assert.equal((await post({...payload,event_id:'bad\nidentifier'})).status,400);
  const results=await Promise.all([post(payload),post(payload)]);
  assert.ok(results.every(r=>r.status===200),JSON.stringify(await Promise.all(results.map(r=>r.json()))));assert.equal(messages.length,1);
  assert.equal(messages[0].id,'new-channel');assert.equal(messages[0].embed.title,'🆕 PolaBase｜新規登録');
  assert.ok(messages[0].embed.fields.some(f=>f.name==='プレイヤー'&&f.value==='@everyone'));
  assert.ok(!messages[0].embed.fields.some(f=>['Public ID','保存先','楽曲数','譜面数'].includes(f.name)));
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].options.allowedMentions)),{parse:[]});
  await post({source:'score_tool',event_type:'bookmarklet_error',level:'error',event_id:'error-1',stage_label:'スコアの保存',error_code:'SCORE_IMPORT_FAILED',error_message:'保存に失敗しました。',player_name:'A'.repeat(2000)});
  assert.equal(messages.length,2);assert.equal(messages[1].id,'error-channel');
  assert.ok(messages[1].embed.fields.some(f=>f.name==='調査用情報'&&f.value.includes('処理箇所：スコアの保存')));
  assert.ok(messages[1].embed.fields.every(f=>f.value.length<=1024));
  const qap={source:'qap_site',event_type:'qap_admin_activity',level:'info',log:{id:292,action:'qap_record_create',admin_display_name:'管理者',admin_id:'hidden',created_at:'2026-11-06T14:58:13Z',after_data:{music_title:'金木犀',diff:'inf',display_date:'2026/11/06',members:[{name:'プレイヤー',crewid:'1234'}]},success:true}};
  assert.equal((await post(qap)).status,200);
  assert.equal(messages[2].id,'qap-channel');
  assert.equal(messages[2].embed.title,'🆕 PolaQ｜QAPデータ追加');
  assert.ok(messages[2].embed.fields.some(f=>f.name==='楽曲名'&&f.value==='金木犀'));
  assert.doesNotMatch(JSON.stringify(messages[2].embed),/hidden/);
  assert.equal((await post({...qap,log:{...qap.log,id:293,success:false,error_message:'保存できませんでした'}})).status,200);
  assert.equal(messages[3].id,'qap-error-channel');
  assert.equal(messages[3].embed.title,'❌ PolaQ｜追加エラー');
  const crewFill = {
    ...qap,
    log: {
      id: 294,
      action: 'qap_member_crewid_fill',
      admin_display_name: '管理者',
      admin_id: 'hidden',
      created_at: '2026-11-06T14:58:13Z',
      success: true,
      detail: {crew_id: '12345678', target_names: ['A', 'B'], updated_member_count: 3, updated_record_count: 2},
    },
  };
  assert.equal((await post(crewFill)).status, 200);
  assert.equal(messages[4].id, 'qap-channel');
  const fillEmbed = messages[4].embed;
  assert.equal(fillEmbed.title, '🔗 PolaQ｜Crew ID補完');
  assert.deepEqual(fillEmbed.fields.map(field => field.value), [
    '12345678', '・A\n・B', 'メンバー：3人\nQAPデータ：2件',
    '管理アカウント：管理者\n実行日時：2026/11/06 23:58:13\nlogid：294',
  ]);
  assert.equal((await post({...crewFill, log: {...crewFill.log, success: false}})).status, 200);
  assert.equal(messages[5].id, 'qap-error-channel');
  assert.equal(messages[5].embed.title, '❌ PolaQ｜Crew ID補完エラー');
  assert.equal(messages[5].embed.fields.at(-1).name, '調査用情報');
  const health=await(await fetch(origin+'/health')).json();
  assert.equal(health.revision,'fixture-revision');assert.equal(health.score_notifications_configured,true);
  assert.doesNotMatch(JSON.stringify(health),/fixture-api-token|fixture-bot|token_hint/);
});
