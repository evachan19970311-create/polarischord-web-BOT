# PolarisChord Web Notification BOT

既存のQAP通知と、PolaBaseの新規登録・スコア登録エラー通知を扱います。

## PolaBase連携

`POST /notify` に `Authorization: Bearer <DISCORD_NOTIFY_API_TOKEN>` を指定します。

- `source`: `score_tool`
- 新規登録: `event_type=bookmarklet`, `level=info`, `is_initial=true`
- 登録エラー: `event_type=bookmarklet_error`, `level=error`
- `event_id`: 任意の英数字・`_:.-`、最大128文字。同じsource・event_type・event_idは再送しても1回だけ送信します。
- 新規登録先: `DISCORD_CHANNEL_SCORE_LOG`
- エラー先: `DISCORD_CHANNEL_SCORE_ERROR_LOG`。未設定なら通常ログのチャンネルを使用します。

SupabaseのEdge Function Secretsには以下を設定します。秘密の値をリポジトリに保存しないでください。

- `DISCORD_NOTIFY_API_URL`: `https://polarischord-web-bot.onrender.com/notify`
- `DISCORD_NOTIFY_API_TOKEN`: Renderの同名設定と同じAPI認証用トークン。DiscordのBOTトークンとは別です。

重複防止はプロセス内メモリで最大5,000件、成功後24時間保持します。再起動時はリセットされます。失敗した通知は再送可能です。既存のevent_idを持たない通知も従来通り受け付けます。

`GET /health` はBOTの接続状態・通知先設定の有無・RenderのコミットIDを返します。認証用トークンの一部は返しません。

## 検証

`npm ci` と `npm test` を実行します。通知APIのテストはDiscordクライアントの送信を置き換えるため、実際のDiscordチャンネルには投稿しません。
