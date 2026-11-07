"use strict";

const express = require("express");
const crypto = require("crypto");
const { buildScoreEmbed, buildQapRecordEmbed, buildQapCrewIdFillEmbed } = require("./notification-formatters");
const { createNotificationDeduplicator } = require("./notification-dedup");
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
  DISCORD_CHANNEL_SCORE_ERROR_LOG,
  DISCORD_CHANNEL_QAP_LOG,
  DISCORD_CHANNEL_QAP_ERROR_LOG,

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
const deliverOnce = createNotificationDeduplicator();
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
   * 通常通知 / エラー通知 の2チャンネル構成
   */
  if (source === "score_tool") {
    if (level === "error") {
      return DISCORD_CHANNEL_SCORE_ERROR_LOG || DISCORD_CHANNEL_SCORE_LOG || null;
    }

    return DISCORD_CHANNEL_SCORE_LOG || null;
  }

  /*
   * QAPサイト:
   * 通常通知 / エラー通知 の2チャンネル構成
   */
  if (source === "qap_site") {
    if (level === "error") {
      return DISCORD_CHANNEL_QAP_ERROR_LOG || DISCORD_CHANNEL_QAP_LOG || null;
    }

    return DISCORD_CHANNEL_QAP_LOG || null;
  }

  /*
   * 不明なsource:
   * errorならQAP/スコアのエラー通知へ逃がす。
   */
  if (level === "error") {
    return (
      DISCORD_CHANNEL_QAP_ERROR_LOG ||
      DISCORD_CHANNEL_SCORE_ERROR_LOG ||
      DISCORD_CHANNEL_QAP_LOG ||
      DISCORD_CHANNEL_SCORE_LOG ||
      null
    );
  }

  return (
    DISCORD_CHANNEL_SCORE_LOG ||
    DISCORD_CHANNEL_QAP_LOG ||
    DISCORD_CHANNEL_SCORE_ERROR_LOG ||
    DISCORD_CHANNEL_QAP_ERROR_LOG ||
    null
  );
}

/* =========================================================
 * Embedビルダー
 * ========================================================= */

function buildScoreBookmarkletEmbed(payload) { return buildScoreEmbed(payload); }

function buildScoreBookmarkletErrorEmbed(payload) { return buildScoreEmbed(payload, true); }

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

function buildQapSaveEmbed(payload) { return buildQapRecordEmbed(payload, "create"); }

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

function buildQapJacketUploadEmbed(payload) {
  const result = payload.result || {};
  const admin = payload.admin || {};

  const uploadedCount = Number(result.uploaded_count || 0);
  const skippedCount = Number(result.skipped_count || 0);
  const failedCount = Number(result.failed_count || 0);
  const overwrite = result.overwrite === true;

  const uploadedItems = toArray(result.uploaded_music_ids)
    .slice(0, 20)
    .map((id) => `・${String(id)}`);

  const failedItems = toArray(result.failed)
    .slice(0, 10)
    .map((item) => {
      if (typeof item === "string") {
        return `・${item}`;
      }

      return `・${item && item.music_id ? item.music_id : "-"}: ${
        item && item.reason ? item.reason : "-"
      }`;
    });

  const fields = [
    {
      name: "管理者",
      value: `${admin.display_name || "-"}\n${admin.admin_id || "-"}`,
      inline: true,
    },
    {
      name: "保存先",
      value: [
        `bucket: ${result.bucket || "-"}`,
        `path: ${result.base_path || "jacket/"}`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "実行結果",
      value: [
        `uploaded: ${uploadedCount}`,
        `skipped: ${skippedCount}`,
        `failed: ${failedCount}`,
        `overwrite: ${String(overwrite)}`,
        `max_count: ${result.max_count ?? "-"}`,
      ].join("\n"),
      inline: false,
    },
    {
      name: "実行時刻",
      value: formatJstDateTime(payload.executed_at || nowIso()),
      inline: false,
    },
  ];

  if (uploadedItems.length > 0) {
    fields.push({
      name: "アップロードしたmusic_id（最大20件）",
      value: splitLinesToFieldValue(uploadedItems, 1000),
      inline: false,
    });
  }

  if (failedItems.length > 0) {
    fields.push({
      name: "失敗（最大10件）",
      value: splitLinesToFieldValue(failedItems, 1000),
      inline: false,
    });
  }

  const title =
    failedCount > 0
      ? "⚠️ QAPジャケット画像アップロード 一部失敗"
      : uploadedCount > 0
        ? "🖼️ QAPジャケット画像アップロード完了"
        : "✅ QAPジャケット画像確認完了";

  const color =
    failedCount > 0
      ? 0xfee75c
      : uploadedCount > 0
        ? 0x57f287
        : 0x95a5a6;

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(...fields)
    .setFooter(buildFooter("PolarisChord QAP Jacket Upload"))
    .setTimestamp(new Date());
}

function buildQapUpdateEmbed(payload) { return buildQapRecordEmbed(payload, "update"); }

function buildQapDeleteEmbed(payload) { return buildQapRecordEmbed(payload, "delete"); }

function formatQapAdminActionLabel(action) {
  switch (String(action || "")) {
    case "qap_record_create":
      return "QAPデータ追加";
    case "qap_record_update":
      return "QAPデータ編集";
    case "qap_record_delete":
      return "QAPデータ削除";
    default:
      return String(action || "-");
  }
}

function getQapAdminActivityStyle(action) {
  switch (String(action || "")) {
    case "qap_record_create":
      return {
        title: "✅ QAPデータ追加",
        color: 0x57f287,
      };
    case "qap_record_update":
      return {
        title: "✏️ QAPデータ編集",
        color: 0xfee75c,
      };
    case "qap_record_delete":
      return {
        title: "🗑️ QAPデータ削除",
        color: 0xed4245,
      };
    default:
      return {
        title: "🛠️ QAP管理操作",
        color: 0x5865f2,
      };
  }
}

function buildQapAdminActivityEmbed(payload) {
  const log = payload.log || {};
  const action = String(log.action || payload.action || "");
  if (action === "qap_member_crewid_fill") return buildQapCrewIdFillEmbed(payload);
  if (["qap_record_create", "qap_record_update", "qap_record_delete"].includes(action) || log.success === false) return buildQapRecordEmbed(payload);
  const style = getQapAdminActivityStyle(action);

  const detail = log.detail || {};

  const adminName = String(log.admin_display_name || "-");
  const adminId = String(log.admin_id || "-");
  const createdAt = log.created_at || payload.executed_at || nowIso();

  const fields = [
    {
      name: "操作",
      value: formatQapAdminActionLabel(action),
      inline: true,
    },
    {
      name: "管理者",
      value: `${adminName}\n${adminId}`,
      inline: true,
    },
    {
      name: "実行日時",
      value: formatJstDateTime(createdAt),
      inline: false,
    },
  ];

  fields.push({
    name: "詳細",
    value: truncate(safeJson(detail), 1000),
    inline: false,
  });

  if (log.id != null) {
    fields.push({
      name: "log_id",
      value: String(log.id),
      inline: true,
    });
  }

  return new EmbedBuilder()
    .setTitle(style.title)
    .setColor(style.color)
    .addFields(...fields)
    .setFooter(buildFooter("PolarisChord QAP Admin Activity"))
    .setTimestamp(new Date());
}

function buildQapErrorEmbed(payload) { return buildQapRecordEmbed(payload, "error"); }

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
  if (source === "qap_site" && eventType === "qap_jacket_upload") {
    return buildQapJacketUploadEmbed(payload);
  }
  if (source === "qap_site" && eventType === "qap_admin_activity") {
    return buildQapAdminActivityEmbed(payload);
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
  const level = (source === "qap_site" && (eventType === "qap_error" || payload.log?.success === false)) || (source === "score_tool" && eventType === "bookmarklet_error") ? "error" : String(payload.level || "").toLowerCase();

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
    ...(source === "score_tool" ? { allowedMentions: { parse: [] } } : {}),
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
    revision: process.env.RENDER_GIT_COMMIT || null,
    score_notifications_configured: Boolean(DISCORD_CHANNEL_SCORE_LOG),
    score_error_notifications_configured: Boolean(DISCORD_CHANNEL_SCORE_ERROR_LOG || DISCORD_CHANNEL_SCORE_LOG),
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

    if (payload.event_id !== undefined && (typeof payload.event_id !== "string" || !/^[a-zA-Z0-9_:.-]{1,128}$/.test(payload.event_id))) {
      return res.status(400).json({ ok: false, error: "Invalid event_id" });
    }
    const key = payload.event_id ? `${source}:${eventType}:${payload.event_id}` : null;
    const result = await deliverOnce(key, () => enqueueMessage(() => sendNotification(payload)));

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
