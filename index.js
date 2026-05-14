"use strict";

const express = require("express");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
} = require("discord.js");

/* =========================================================
 * 基本設定
 * ========================================================= */

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_NOTIFY_API_TOKEN,
  PORT = "3000",

  // チャンネルID
  DISCORD_CHANNEL_SCORE_LOG,
  DISCORD_CHANNEL_QAP_LOG,
  DISCORD_CHANNEL_ERROR_LOG,

  // 任意: 個別に分けたい場合はこれらを使う
  DISCORD_CHANNEL_SCORE_BOOKMARKLET,
  DISCORD_CHANNEL_SCORE_MUSICDATA,
  DISCORD_CHANNEL_SCORE_APDIFF,
  DISCORD_CHANNEL_QAP_DOPST,
  DISCORD_CHANNEL_QAP_SUMMARY,
} = process.env;

if (!DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}
if (!DISCORD_NOTIFY_API_TOKEN) {
  throw new Error("DISCORD_NOTIFY_API_TOKEN is required");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const queue = [];
let is_sending = false;

/* =========================================================
 * ユーティリティ
 * ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function formatJstDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value || "-");
  }

  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : "";
  };

  return [
    `${get("year")}/${get("month")}/${get("day")}`,
    `${get("hour")}:${get("minute")}:${get("second")}`,
  ].join(" ");
}

function truncate(text, max = 1000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + "...";
}

function toArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function maskToken(token) {
  if (!token) return "-";
  if (token.length <= 8) return "********";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

function verifyBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  return timingSafeEqual(token, DISCORD_NOTIFY_API_TOKEN);
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function normalizeSource(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEventType(value) {
  return String(value || "").trim().toLowerCase();
}

function buildFooter(text) {
  return { text: text || "PolarisChord Notification Bot" };
}

function splitLinesToFieldValue(lines, maxLength = 1000) {
  const text = lines.filter(Boolean).join("\n");
  return text ? truncate(text, maxLength) : "-";
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function resolveChannelId(source, eventType, level) {
  /*
   * スコアツール:
   * Supabase移行後は、通知種別ごとの細分化をやめて
   * 通常通知 / エラー通知 の2チャンネル構成に統合する。
   */
  if (source === "score_tool") {
    if (level === "error") {
      return DISCORD_CHANNEL_ERROR_LOG || null;
    }

    return DISCORD_CHANNEL_SCORE_LOG || null;
  }

  /*
   * QAPサイト:
   * 今回は既存運用を維持する。
   */
  if (source === "qap_site") {
    if (level === "error") {
      return DISCORD_CHANNEL_ERROR_LOG || DISCORD_CHANNEL_QAP_LOG || null;
    }

    if (eventType === "qap_summary_update") {
      return DISCORD_CHANNEL_QAP_SUMMARY || DISCORD_CHANNEL_QAP_LOG || null;
    }

    if (
      eventType === "qap_save" ||
      eventType === "qap_update" ||
      eventType === "qap_delete" ||
      eventType === "qap_error"
    ) {
      return DISCORD_CHANNEL_QAP_DOPST || DISCORD_CHANNEL_QAP_LOG || null;
    }

    return DISCORD_CHANNEL_QAP_LOG || null;
  }

  /*
   * 不明なsource:
   * errorならエラー通知、それ以外は通常通知へ逃がす。
   */
  if (level === "error") {
    return DISCORD_CHANNEL_ERROR_LOG || null;
  }

  return DISCORD_CHANNEL_SCORE_LOG ||
    DISCORD_CHANNEL_QAP_LOG ||
    DISCORD_CHANNEL_ERROR_LOG ||
    null;
}

/* =========================================================
 * Embedビルダー
 * ========================================================= */

function buildScoreBookmarkletEmbed(payload) {
  const isInitial = Boolean(payload.is_initial);
  const hasDiff = Boolean(payload.has_diff);

  const title = isInitial
    ? "🆕 スコアツール 新規登録"
    : hasDiff
      ? "📈 スコアデータ更新"
      : "✅ スコア登録完了";

  const color = isInitial ? 0x3498db : hasDiff ? 0x2ecc71 : 0x95a5a6;

  const diffText = hasDiff
    ? String(payload.diff_summary || "差分あり")
    : "差分なし";

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(
      isInitial
        ? "新しいユーザーのスコアデータをSupabaseへ登録しました。"
        : hasDiff
          ? "既存ユーザーのスコアデータをSupabaseへ更新しました。"
          : "スコア登録は完了しました。前回との差分はありません。"
    )
    .addFields(
      { name: "プレイヤー", value: String(payload.player_name || "-"), inline: true },
      { name: "Crew ID", value: String(payload.crew_id || "-"), inline: true },
      { name: "public_id", value: String(payload.public_id || "-"), inline: false },
      { name: "登録種別", value: isInitial ? "新規登録" : "更新", inline: true },
      { name: "差分", value: hasDiff ? "あり" : "なし", inline: true },
      { name: "楽曲数", value: String(payload.music_count ?? "-"), inline: true },
      {
        name: "保存先",
        value: [
          "users / user_scores",
          "user_privacy_settings",
          "update_results",
          payload.history_path ? "user_score_snapshots" : null,
        ].filter(Boolean).join("\n"),
        inline: false,
      },
      {
        name: "差分サマリー",
        value: truncate(diffText, 1000),
        inline: false,
      },
      { name: "登録日時", value: formatJstDateTime(payload.exported_at), inline: false },
    )
    .setFooter(buildFooter("PolarisChord ScoreTool / Supabase"))
    .setTimestamp(new Date());
}

function buildScoreBookmarkletErrorEmbed(payload) {
  return new EmbedBuilder()
    .setTitle("❌ スコア登録エラー")
    .setColor(0xed4245)
    .setDescription("ブックマークレット実行中にエラーが発生しました。")
    .addFields(
      { name: "stage", value: String(payload.stage || "-"), inline: true },
      { name: "プレイヤー", value: String(payload.player_name || "-"), inline: true },
      { name: "Crew ID", value: String(payload.crew_id || "-"), inline: true },
      { name: "public_id", value: String(payload.public_id || "-"), inline: false },
      {
        name: "エラー内容",
        value: truncate(String(payload.error_message || "-"), 1000),
        inline: false,
      },
      { name: "発生日時", value: formatJstDateTime(payload.exported_at), inline: false },
    )
    .setFooter(buildFooter("PolarisChord ScoreTool Error"))
    .setTimestamp(new Date());
}

function buildScoreMusicDataEmbed(payload) {
  const diffType = String(payload.diff_type || "unknown");

  const titleMap = {
    first_upload: "🆕 楽曲マスタ 初回登録",
    updated: "📈 楽曲マスタ 更新あり",
    no_diff: "✅ 楽曲マスタ 更新なし",
  };

  const colorMap = {
    first_upload: 0x3498db,
    updated: 0x2ecc71,
    no_diff: 0x95a5a6,
  };

  const labels = toArray(payload.changed_song_labels)
    .slice(0, 20)
    .map((label) => "・" + String(label));

  return new EmbedBuilder()
    .setTitle(titleMap[diffType] || `📦 楽曲マスタ更新: ${diffType}`)
    .setColor(colorMap[diffType] || 0x5865f2)
    .setDescription(
      payload.has_diff
        ? "公式楽曲データとの差分を検知し、楽曲マスタを更新しました。"
        : "公式楽曲データを確認しました。更新差分はありません。"
    )
    .addFields(
      { name: "保存先", value: "music_master / 関連マスタデータ", inline: false },
      { name: "楽曲数", value: String(payload.song_count ?? 0), inline: true },
      { name: "譜面数", value: String(payload.diff_count ?? 0), inline: true },
      { name: "差分", value: payload.has_diff ? "あり" : "なし", inline: true },
      { name: "追加 / 更新曲数", value: String(toArray(payload.changed_song_ids).length), inline: true },
      {
        name: "追加 / 更新楽曲名（最大20件）",
        value: splitLinesToFieldValue(labels),
        inline: false,
      },
      { name: "実行日時", value: formatJstDateTime(payload.executed_at), inline: false },
    )
    .setFooter(buildFooter("PolarisChord ScoreTool / Music Master"))
    .setTimestamp(new Date());
}

function buildScoreApdiffEmbed(payload) {
  const changedItems = toArray(payload.changed_items)
    .slice(0, 20)
    .map((item) => {
      const title = String(item && item.title || "-");
      const diffName = String(item && item.diff_name || "-");
      const oldValue = item && item.old_value != null ? item.old_value : "-";
      const newValue = item && item.new_value != null ? item.new_value : "-";
      return `・${title} [${diffName}] : ${oldValue} → ${newValue}`;
    });

  const addedCount = Number(payload.added_count ?? 0);
  const removedCount = Number(payload.removed_count ?? 0);
  const changedCount = Number(payload.changed_count ?? 0);
  const hasDiff = addedCount + removedCount + changedCount > 0;

  const description = [
    hasDiff
      ? "AP難易度マスタに更新差分があります。"
      : "AP難易度マスタを確認しました。更新差分はありません。",
    "",
    "**バージョン**",
    `・旧: ${payload.old_ver ?? "-"}`,
    `・新: ${payload.new_ver ?? "-"}`,
    "",
    "**差分件数**",
    `・追加: ${addedCount}件`,
    `・削除: ${removedCount}件`,
    `・変更: ${changedCount}件`,
    changedItems.length ? "" : null,
    changedItems.length ? "**変更例（最大20件）**" : null,
    changedItems.length ? changedItems.join("\n") : null,
  ].filter(Boolean).join("\n");

  return new EmbedBuilder()
    .setTitle(hasDiff ? "📈 AP難易度マスタ 更新あり" : "✅ AP難易度マスタ 更新なし")
    .setColor(hasDiff ? 0x2ecc71 : 0x95a5a6)
    .setDescription(truncate(description, 4000))
    .setFooter(
      buildFooter(
        `PolarisChord ScoreTool / AP Difficulty / 更新日時: ${formatJstDateTime(payload.executed_at || nowIso())}`
      )
    )
    .setTimestamp(new Date());
}

function buildQapSaveEmbed(payload) {
  const record = payload.record || {};
  const members = toArray(record.members).map((member) => {
    const name = String(member && member.name || "-").trim() || "-";
    const crewid = String(member && member.crewid || "-").trim() || "-";
    return `・${name} / ${crewid}`;
  });

  return new EmbedBuilder()
    .setTitle("✅ QAPデータ登録完了")
    .setColor(0x57f287)
    .addFields(
      { name: "日付", value: String(record.display_date || "-"), inline: true },
      { name: "曲名", value: String(record.music_title || "-"), inline: true },
      { name: "難易度", value: String(record.diff || "-").toUpperCase(), inline: true },
      { name: "プレイヤー", value: splitLinesToFieldValue(members), inline: false },
      {
        name: "GitHub",
        value:
          "qap_data: " + (payload.qap_data_commit_sha ? String(payload.qap_data_commit_sha).slice(0, 7) : "-") + "\n" +
          "summary: " + (payload.qap_summary_commit_sha ? String(payload.qap_summary_commit_sha).slice(0, 7) : "-"),
        inline: false,
      },
    )
    .setFooter(buildFooter("PolarisChord QAP Web"))
    .setTimestamp(new Date());
}

function buildQapSummaryEmbed(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const changedItems = Array.isArray(payload.changed_items) ? payload.changed_items : [];

  const hasError =
    results.some((item) => item && item.success === false) ||
    Boolean(payload.error_message);

  const resultText = results.length
    ? results
        .map((item) => {
          const status = String(item && item.status || '-');
          return status;
        })
        .join('\n')
    : '-';

  const changedText = changedItems.length
    ? changedItems.map((item) => '・' + String(item)).join('\n')
    : '-';

  return new EmbedBuilder()
    .setTitle(hasError ? '⚠️ QAP summary_data 更新エラー' : '📦 QAP summary_data 更新結果')
    .setColor(hasError ? 0xed4245 : 0x5865f2)
    .addFields(
      { name: '結果', value: resultText, inline: false },
      { name: 'エラー', value: String(payload.error_message || '-'), inline: false },
      { name: '更新内容', value: changedText, inline: false },
      { name: '実行時刻', value: String(payload.executed_at || '-'), inline: false }
    )
    .setFooter(buildFooter('PolarisChord QAP Summary Updater'))
    .setTimestamp(new Date());
}

function buildQapUpdateEmbed(payload) {
  const beforeRecord = payload.before_record || {};
  const afterRecord = payload.after_record || {};

  return new EmbedBuilder()
    .setTitle("✏️ QAPデータ編集完了")
    .setColor(0xfee75c)
    .addFields(
      { name: "曲名", value: String(beforeRecord.music_title || "-"), inline: true },
      { name: "難易度", value: String(beforeRecord.diff || "-").toUpperCase(), inline: true },
      {
        name: "日付",
        value: `${beforeRecord.display_date || "-"} → ${afterRecord.display_date || "-"}`,
        inline: false,
      },
    )
    .setFooter(buildFooter("PolarisChord QAP Web"))
    .setTimestamp(new Date());
}

function buildQapDeleteEmbed(payload) {
  const record = payload.record || {};
  const members = toArray(record.members).map((member) => {
    const name = String(member && member.name || "-").trim() || "-";
    const crewid = String(member && member.crewid || "-").trim() || "-";
    return `・${name} / ${crewid}`;
  });

  return new EmbedBuilder()
    .setTitle("🗑️ QAPデータ削除完了")
    .setColor(0xed4245)
    .addFields(
      { name: "日付", value: String(record.display_date || "-"), inline: true },
      { name: "曲名", value: String(record.music_title || "-"), inline: true },
      { name: "難易度", value: String(record.diff || "-").toUpperCase(), inline: true },
      { name: "プレイヤー", value: splitLinesToFieldValue(members), inline: false },
      {
        name: "GitHub",
        value:
          "qap_data: " + (payload.qap_data_commit_sha ? String(payload.qap_data_commit_sha).slice(0, 7) : "-") + "\n" +
          "summary: " + (payload.qap_summary_commit_sha ? String(payload.qap_summary_commit_sha).slice(0, 7) : "-"),
        inline: false,
      },
    )
    .setFooter(buildFooter("PolarisChord QAP Web"))
    .setTimestamp(new Date());
}

function buildQapErrorEmbed(payload) {
  const record = payload.payload && payload.payload.record ? payload.payload.record : null;
  const fields = [
    { name: "stage", value: String(payload.stage || "-"), inline: true },
    { name: "error", value: truncate(String(payload.error_message || "-"), 1000), inline: false },
  ];

  if (record) {
    const members = toArray(record.members).map((member) => {
      const name = String(member && member.name || "-").trim() || "-";
      const crewid = String(member && member.crewid || "-").trim() || "-";
      return `・${name} / ${crewid}`;
    });

    fields.push(
      { name: "日付", value: String(record.display_date || "-"), inline: true },
      { name: "曲名", value: String(record.music_title || "-"), inline: true },
      { name: "難易度", value: String(record.diff || "-").toUpperCase(), inline: true },
      { name: "プレイヤー", value: splitLinesToFieldValue(members), inline: false },
    );
  }

  return new EmbedBuilder()
    .setTitle("❌ QAPデータ登録エラー")
    .setColor(0xed4245)
    .addFields(fields)
    .setFooter(buildFooter("PolarisChord QAP Web"))
    .setTimestamp(new Date());
}

function buildGenericEmbed(payload) {
  const level = String(payload.level || "info").toLowerCase();
  const isError = level === "error";

  return new EmbedBuilder()
    .setTitle(isError ? "⚠️ 未定義エラー通知" : "🔔 未定義通知")
    .setColor(isError ? 0xed4245 : 0x5865f2)
    .setDescription("BOT側で専用Embedが定義されていない通知です。")
    .addFields(
      { name: "source", value: String(payload.source || "-"), inline: true },
      { name: "event_type", value: String(payload.event_type || "-"), inline: true },
      { name: "level", value: String(payload.level || "-"), inline: true },
      {
        name: "payload",
        value: truncate(safeJson(payload), 1000),
        inline: false,
      },
    )
    .setFooter(buildFooter("PolarisChord Notification Bot"))
    .setTimestamp(new Date());
}

function buildEmbed(payload) {
  const source = normalizeSource(payload.source);
  const eventType = normalizeEventType(payload.event_type);

  if (source === "score_tool" && eventType === "bookmarklet") {
    return buildScoreBookmarkletEmbed(payload);
  }
  if (source === "score_tool" && eventType === "bookmarklet_error") {
    return buildScoreBookmarkletErrorEmbed(payload);
  }
  if (source === "score_tool" && eventType === "music_data") {
    return buildScoreMusicDataEmbed(payload);
  }
  if (source === "score_tool" && eventType === "apdiff") {
    return buildScoreApdiffEmbed(payload);
  }

  /*
   * QAP系は既存のまま維持
   */
  if (source === "qap_site" && eventType === "qap_save") {
    return buildQapSaveEmbed(payload);
  }
  if (source === "qap_site" && eventType === "qap_update") {
    return buildQapUpdateEmbed(payload);
  }
  if (source === "qap_site" && eventType === "qap_delete") {
    return buildQapDeleteEmbed(payload);
  }
  if (source === "qap_site" && eventType === "qap_error") {
    return buildQapErrorEmbed(payload);
  }
  if (source === "qap_site" && eventType === "qap_summary_update") {
    return buildQapSummaryEmbed(payload);
  }

  return buildGenericEmbed(payload);
}

/* =========================================================
 * 送信キュー
 * ========================================================= */

async function enqueueMessage(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    processQueue().catch((error) => {
      console.error("[queue] fatal:", error);
    });
  });
}

async function processQueue() {
  if (is_sending) return;
  is_sending = true;

  try {
    while (queue.length > 0) {
      const item = queue.shift();

      try {
        const result = await item.job();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }

      await sleep(1200);
    }
  } finally {
    is_sending = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
 * Discord送信
 * ========================================================= */

async function sendNotification(payload) {
  const source = normalizeSource(payload.source);
  const eventType = normalizeEventType(payload.event_type);
  const level = String(payload.level || "").toLowerCase();

  const channelId = resolveChannelId(source, eventType, level);
  if (!channelId) {
    throw new Error(`No channel mapping found for source=${source}, event_type=${eventType}, level=${level}`);
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel is not text based or not found: ${channelId}`);
  }

  const embed = buildEmbed(payload);
  const content = payload.content ? String(payload.content) : null;

  const message = await channel.send({
    content: content || undefined,
    embeds: [embed],
  });

  return {
    ok: true,
    channel_id: channelId,
    message_id: message.id,
  };
}

/* =========================================================
 * API
 * ========================================================= */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "polaris-notify-bot",
    time: nowIso(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    logged_in: client.isReady(),
    bot_user: client.user ? client.user.tag : null,
    queue_length: queue.length,
    token_hint: maskToken(DISCORD_NOTIFY_API_TOKEN),
    time: nowIso(),
  });
});

app.post("/notify", async (req, res) => {
  try {
    if (!verifyBearerToken(req)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const payload = req.body || {};
    const source = normalizeSource(payload.source);
    const eventType = normalizeEventType(payload.event_type);

    if (!source) {
      return res.status(400).json({
        ok: false,
        error: "source is required",
      });
    }

    if (!eventType) {
      return res.status(400).json({
        ok: false,
        error: "event_type is required",
      });
    }

    const result = await enqueueMessage(() => sendNotification(payload));

    return res.json({
      ok: true,
      queued: true,
      result,
    });
  } catch (error) {
    console.error("[/notify] error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/* =========================================================
 * 起動
 * ========================================================= */

async function start() {
  client.once("ready", () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
  });

  await client.login(DISCORD_BOT_TOKEN);

  app.listen(Number(PORT), () => {
    console.log(`[http] listening on :${PORT}`);
  });
}

start().catch((error) => {
  console.error("[startup] failed:", error);
  process.exit(1);
});
