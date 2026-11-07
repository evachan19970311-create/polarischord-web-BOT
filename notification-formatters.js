"use strict";

const { EmbedBuilder } = require("discord.js");
const clip = (value, max=900) => {
  const text=String(value ?? "");
  return text.length>max ? text.slice(0,max-1).replace(/[\uD800-\uDBFF]$/,"")+"…" : text;
};
const line = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g," ").trim();
const present = value => value !== undefined && value !== null && String(value).trim() !== "";

// Legacy GAS strings without an offset are already Japanese local time.
function dateTime(value) {
  if (!present(value)) return "取得できませんでした";
  const text=line(value);
  const local=text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (local) {
    const [,year,month,day,hour,minute,second]=local;
    return `${year}/${month.padStart(2,"0")}/${day.padStart(2,"0")}`+(hour?` ${hour.padStart(2,"0")}:${minute}:${second || "00"}`:"");
  }
  const date=new Date(text);
  if (!Number.isFinite(date.getTime())) return "取得できませんでした";
  return new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(date);
}
function difficulty(value) {
  const normalized=line(value).toUpperCase();
  return ["INFLUENCE","INF"].includes(normalized)?"INF":normalized || "取得できませんでした";
}
function members(record) {
  if (!Array.isArray(record?.members) || !record.members.length) return "取得できませんでした";
  return record.members.map((member,index)=>({member:member && typeof member==="object"?member:{},index})).sort((a,b)=>(a.member.member_index ?? a.index)-(b.member.member_index ?? b.index)).map(({member,index})=>{
    const number=Number.isInteger(member.member_index)&&member.member_index>=0?member.member_index+1:index+1;
    const crew=line(member.crewid ?? member.crew_id);
    return `${number}. ${line(member.name || member.player_name) || "名前未登録"}（Crew ID：${!crew || crew==="-"?"未登録":crew}）`;
  }).join("\n");
}
function makeEmbed(title,color,fields,footer) {
  // Stay within Discord's individual-field and whole-embed limits.
  let remaining=5500-Array.from(title+footer).length;
  const safe=fields.slice(0,25).map(field=>{
    const value=clip(field.value,Math.max(1,Math.min(900,remaining-Array.from(field.name).length)));
    remaining-=Array.from(field.name+value).length;
    return {name:field.name,value:value || "取得できませんでした",inline:field.inline ?? false};
  });
  return new EmbedBuilder().setTitle(title).setColor(color).addFields(safe).setFooter({text:footer});
}
const field=(name,value,inline=false)=>({name,value,inline});
const operations = (payload,log={},error=false) => {
  const nested=payload.payload || {};
  const admin=log.admin_display_name || payload.admin_display_name || payload.requested_admin?.display_name || payload.admin?.display_name || nested.admin_display_name;
  const id=log.id ?? payload.log_id ?? payload.logid ?? nested.log_id ?? nested.logid;
  const time=log.created_at || payload.executed_at || payload.exported_at;
  const timeLabel=error?(time?"発生日時":"通知受信日時"):"実行日時";
  return field("操作情報",[
    `管理アカウント：${line(admin) || "取得できませんでした"}`,
    `${timeLabel}：${dateTime(time || (error?new Date().toISOString():undefined))}`,
    `logid：${present(id)?line(id):"取得できませんでした"}`,
  ].join("\n"));
};
function recordFields(record) {
  if (!record) return [field("記録情報","楽曲名・難易度・達成日時を取得できませんでした。")];
  return [field("楽曲名",line(record.music_title) || "取得できませんでした"),field("難易度",difficulty(record.diff),true),field("達成日時",dateTime(record.display_date),true),field("プレイヤー",members(record))];
}
function changedFields(before,after) {
  if (!before || !after) return [field("変更内容","変更前後の情報を取得できませんでした。")];
  const changes=[];
  for (const [name,oldValue,newValue] of [
    ["楽曲名",line(before.music_title),line(after.music_title)],
    ["難易度",difficulty(before.diff),difficulty(after.diff)],
    ["達成日時",dateTime(before.display_date),dateTime(after.display_date)],
  ]) if (oldValue!==newValue) changes.push(`${name}：${clip(oldValue || "未登録",180)} → ${clip(newValue || "未登録",180)}`);
  const oldMembers=members(before),newMembers=members(after);
  if (oldMembers!==newMembers) {
    const oldLines=oldMembers.split("\n"),newLines=newMembers.split("\n");
    const memberChanges=Array.from({length:Math.max(oldLines.length,newLines.length)},(_,i)=>oldLines[i]===newLines[i]?null:`${clip(oldLines[i] || "未登録",130)} → ${clip(newLines[i] || "削除",130)}`).filter(Boolean);
    changes.push(`プレイヤー：\n${memberChanges.join("\n")}`);
  }
  return [field("変更内容",changes.join("\n") || "表示項目に変更はありません。")];
}
const STAGES={
  validate_input:"送信データの確認",configuration:"サーバー設定の確認",check_maintenance:"稼働状態の確認",
  prepare_atomic_import:"登録データの準備",commit_atomic_import:"スコアの保存",forward_upload:"登録サーバーとの通信",
  notify_qap_admin_activity:"管理操作の通知",run_qap_summary_update:"集計データの更新",upload_qap_jackets_to_github:"ジャケット画像の更新",
  qap_record_create:"QAPデータの追加",qap_record_update:"QAPデータの編集",qap_record_delete:"QAPデータの削除",
  qap_member_crewid_fill:"Crew ID補完",
};
function errorDetails(payload,log={}) {
  const rawStage=line(payload.stage || log.action);
  const stage=payload.stage_label || STAGES[rawStage] || (/^[a-z0-9_-]{1,80}$/i.test(rawStage)?rawStage:"処理箇所を取得できませんでした");
  const code=line(payload.error_code || log.detail?.error_code);
  return field("調査用情報",`処理箇所：${line(stage)}`+(code?`\nエラーコード：${code}`:""));
}
function buildScoreEmbed(payload,isError=false) {
  const fields=[];
  if (present(payload.player_name)||present(payload.crew_id)) {
    fields.push(field("プレイヤー",line(payload.player_name)||"取得できませんでした"),field("Crew ID",line(payload.crew_id)||"取得できませんでした"));
  } else fields.push(field("プレイヤー情報","取得できませんでした"));
  fields.push(field(isError?"発生日時":"登録日時",dateTime(payload.exported_at || payload.executed_at)));
  if (isError) fields.push(field("エラー内容",payload.error_message || "スコアを登録できませんでした。"),errorDetails(payload));
  return makeEmbed(isError?"❌ PolaBase｜スコア登録エラー":payload.is_initial?"🆕 PolaBase｜新規登録":"✅ PolaBase｜スコア登録完了",isError?0xed4245:0x3498db,fields,"PolaBase");
}
function buildQapRecordEmbed(payload,kind) {
  const log=payload.log || {};
  const action=log.action || payload.action;
  const operation=kind || ({qap_record_create:"create",qap_record_update:"update",qap_record_delete:"delete"}[action]) || "error";
  const error=operation==="error" || log.success===false || payload.level==="error";
  const before=log.before_data || payload.before_record;
  const after=log.after_data || payload.after_record;
  const record=operation==="delete"?before || payload.record:after || payload.record || payload.payload?.record || before;
  const title=error?({create:"追加エラー",update:"編集エラー",delete:"削除エラー"}[operation] || "処理エラー"):{create:"QAPデータ追加",update:"QAPデータ編集",delete:"QAPデータ削除"}[operation];
  const fields=recordFields(record);
  if (!error && operation==="update") fields.push(...changedFields(before,after));
  if (error) fields.push(field("エラー内容",payload.error_message || log.error_message || "処理を完了できませんでした。"));
  fields.push(operations(payload,log,error));
  if (error) fields.push(errorDetails(payload,log));
  return makeEmbed(`${error?"❌":{create:"🆕",update:"✏️",delete:"🗑️"}[operation]} PolaQ｜${title}`,error?0xed4245:{create:0x57f287,update:0xfee75c,delete:0xed4245}[operation],fields,"PolaQ");
}

function buildQapCrewIdFillEmbed(payload) {
  const log = payload.log || {};
  const detail = log.detail || {};
  const error = log.success === false || payload.level === "error";
  const targets = Array.isArray(detail.target_names) ? detail.target_names.map(line).filter(Boolean) : [];
  const fields = [
    field(error ? "補完予定のCrew ID" : "補完したCrew ID", line(detail.crew_id)),
    field("対象プレイヤー", targets.map(name => `・${name}`).join("\n")),
  ];

  if (error) {
    fields.push(field("エラー内容", payload.error_message || log.error_message || "Crew IDを補完できませんでした。"));
  } else {
    fields.push(field("更新件数", [
      `メンバー：${detail.updated_member_count ?? 0}人`,
      `QAPデータ：${detail.updated_record_count ?? 0}件`,
    ].join("\n")));
  }

  fields.push(operations(payload, log, error));
  if (error) fields.push(errorDetails(payload, log));
  return makeEmbed(error ? "❌ PolaQ｜Crew ID補完エラー" : "🔗 PolaQ｜Crew ID補完", error ? 0xed4245 : 0x00d4ff, fields, "PolaQ");
}

module.exports={buildScoreEmbed,buildQapRecordEmbed,buildQapCrewIdFillEmbed,dateTime};
