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

## 通知の表示

- PolaBase: プレイヤー名、Crew ID、登録日時を表示。エラー時は発生日時・エラー内容を先に、処理箇所・エラーコードを下部に表示。Public ID、DBのテーブル名、保存先は表示しません。
- PolaQ: 楽曲名、難易度、達成日時、プレイヤー一覧を表示。管理アカウント名、実行日時、logidを「操作情報」にまとめます。
- PolaQの編集: 変更した項目だけを「変更前 → 変更後」で表示。削除は削除前の記録を使用します。
- プレイヤーは1人1行、未登録のCrew IDは「未登録」と表示します。
- 日付だけの達成記録に時刻を補いません。オフセット付き日時は日本時間へ変換し、GASの日本時間文字列はそのまま扱います。
- 失敗ログを成功通知として表示せず、エラーチャンネルへ送ります。通知に記録・管理アカウント・logidがない場合は推測せず「取得できませんでした」と表示します。
- エラーの発生時刻が届かない場合は、実際の発生時刻と混同しないよう「通知受信日時」を表示します。

## テスト

`npm ci` と `npm test` を実行します。通知APIのテストはDiscordクライアントの送信を置き換えるため、実際のDiscordチャンネルには投稿しません。
