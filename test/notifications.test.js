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
    process:{env:{DISCORD_BOT_TOKEN:'fixture-bot',DISCORD_NOTIFY_API_TOKEN:'fixture-api-token',DISCORD_CHANNEL_SCORE_LOG:'new-channel',DISCORD_CHANNEL_SCORE_ERROR_LOG:'error-channel',RENDER_GIT_COMMIT:'fixture-revision'}},
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
  assert.equal(messages[0].id,'new-channel');assert.equal(messages[0].embed.title,'🆕 スコアツール 新規登録');
  assert.ok(messages[0].embed.fields.some(f=>f.name==='譜面数'&&f.value==='2'));
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].options.allowedMentions)),{parse:[]});
  await post({source:'score_tool',event_type:'bookmarklet_error',level:'error',event_id:'error-1',stage_label:'スコアの保存',error_code:'SCORE_IMPORT_FAILED',error_message:'保存に失敗しました。',player_name:'A'.repeat(2000)});
  assert.equal(messages.length,2);assert.equal(messages[1].id,'error-channel');
  assert.ok(messages[1].embed.fields.some(f=>f.name==='処理'&&f.value==='スコアの保存'));
  assert.ok(messages[1].embed.fields.every(f=>f.value.length<=1024));
  const health=await(await fetch(origin+'/health')).json();
  assert.equal(health.revision,'fixture-revision');assert.equal(health.score_notifications_configured,true);
  assert.doesNotMatch(JSON.stringify(health),/fixture-api-token|fixture-bot|token_hint/);
});
