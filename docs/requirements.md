# Work Log 要件定義

## 目的

Claude Code の作業履歴を自動で収集・可視化し、「いつ何をやっていたか」を一目で把握できるようにする。

## 主要機能(MVP)

状態はすべて「実装済み」。

| # | 機能 | 内容 | 状態 |
| --- | --- | --- | --- |
| 1 | セッション収集 | `~/.claude/projects/` 配下の JSONL を監視し、開始・終了時刻、プロジェクト、メッセージ数を取得する | 実装済み |
| 2 | カレンダー表示 | 週ビュー。縦軸が時間、横軸が曜日。プロジェクト別の色付きブロックで表示する | 実装済み |
| 3 | セッション詳細パネル | 状態(作業中/入力待ち/完了)、コミット数、変更ファイル数、要約を表示する | 実装済み |
| 4 | 自動要約・タグ付け | 要約し、課題・機能・バグ修正などの作業種別とコンポーネント名を自動付与する。既定はルールベース、LLM はオプトイン | 実装済み |
| 5 | フィルタ・検索 | プロジェクト、タグ、期間(週ナビゲーション)、キーワード(全期間)で絞り込む | 実装済み |

補足:

- 機能 1 の「監視」は、ログディレクトリのファイル監視と 60 秒ごとの再確認で実現している。
- 機能 4 のうち LLM による要約・タグ付けは、API キー設定時に明示的に実行したときのみ動く。

## 拡張候補(v2 以降)

| 項目 | 状態 | 備考 |
| --- | --- | --- |
| リアルタイム更新(hooks で SessionStart/Stop を検知) | 実装済み | `hooks install` で登録。作業中/入力待ち/完了を表示。未登録でもファイル監視で動く |
| Git 連携(コミットとセッションの紐付け) | 実装済み | 詳細パネルでリポジトリを読み、コミットを紐付ける(Claude / 同時間帯)。コミット数は成功した `git commit` のみ集計 |
| タスク管理連携(タスクIDへのリンク) | 実装済み | ログ(依頼文・ブランチ名・コミットの件名)からIDを検出し、手動の付け外しもできる。タスクビューで集計する。GitHub / GitLab / Linear / Jira / Backlog / Notion は API 連携も実装済み(任意。タイトル・状態・ラベル・担当者の取得、確認後の作業記録コメント)。Notion はページURLを検出し、データベースの ID プロパティ(`TASK-12` など)も扱う。`ABC-123` 形式のIDは、URL のホスト、`tasks.<サービス>.keys`、設定済みのサービスが1つだけ、の順で振り分ける。GitLab は実際の公開 API で確認済み。Linear / Jira / Backlog / Notion は実際の API で未確認 |
| Codex など他ツールのログ対応 | 実装済み | OpenAI Codex CLI に対応(`~/.codex/sessions/` と `archived_sessions/`、`.jsonl.zst` は Node.js 22.15 以降)。ツールの絞り込みあり。hooks 連携は Claude Code のみ。Gemini CLI・Copilot CLI・Aider・Cursor は下の行 |
| Slack / Discord / Teams / Google Chat 連携(日報・週報、セッション終了の通知) | 実装済み(実 API 未確認) | 画面(週の集計のボタン、確認ダイアログ)と `report` コマンド(`--slack` / `--discord` / `--teams` / `--google-chat`)から、日報・週報を Slack や Discord、Microsoft Teams、Google Chat に送る。Slack の送り先は Incoming Webhook か Bot トークン + チャンネル、Discord は Webhook、Teams は Workflows の Webhook か Incoming Webhook(廃止予定)、Google Chat はスペースの Webhook。`slack.notify` / `discord.notify` / `teams.notify` / `googlechat.notify` が `session_end` なら、hooks の SessionEnd を受けたセッションを通知する。Slack の API は開発環境から接続できず、公式 SDK に合わせた偽サーバーとテストでだけ確認している。Discord も実 API は未確認で、discord-api-types の型定義に合わせた偽サーバーとテストでだけ確認している。Teams も実サービスは未確認で、偽サーバーとテストでだけ確認している。Google Chat も実際のスペースは未確認で、Chat API の discovery document に合わせた偽サーバーとテストでだけ確認している |
| Gemini CLI / Copilot CLI / Aider / Cursor のログ対応 | 実装済み(実ツール未確認) | 取り込み元は `src/sources.js` の一覧に 1 項目足せば増やせる。Gemini CLI は `~/.gemini/tmp/*/chats/`(`WORKLOG_GEMINI_DIR`)、Copilot CLI は `~/.copilot/session-state/`(`WORKLOG_COPILOT_DIR`)、Aider は `WORKLOG_AIDER_DIRS` で指定したフォルダの `.aider.chat.history.md`(未設定なら読まない)、Cursor は `state.vscdb`(`WORKLOG_CURSOR_DIR`。非公式の形式で、Node.js 22.5 以降の `node:sqlite` が必要)。Gemini のモデルの単価は組み込まず、`pricing.json` に書かない限り単価不明として合計から除外する。各ツールの公開ソース・スキーマに合わせたサンプルログとテストでだけ確認している |
| Chatwork / Mattermost / Rocket.Chat / LINE WORKS / 汎用 Webhook 連携(日報・週報、セッション終了の通知) | 実装済み(実サービス未確認) | 送り先は `src/destinations.js` の一覧に 1 項目足せば増やせる。`report` コマンドの `--chatwork` / `--mattermost` / `--rocketchat` / `--lineworks` / `--webhook` と、画面のボタンから送る。Chatwork は API トークン + ルーム ID、Mattermost と Rocket.Chat は Incoming Webhook、LINE WORKS は Bot API 2.0(サービスアカウントの JWT)。汎用 Webhook(`WORKLOG_WEBHOOK_URL`)は集計と各セッションを JSON で送り、`WORKLOG_WEBHOOK_SECRET` があれば `X-WorkLog-Signature`(`"<時刻>.<本文>"` の HMAC-SHA256)と `X-WorkLog-Timestamp` を付ける。いずれも偽サーバーとテストでだけ確認している |
| Confluence / esa / Qiita Team / Obsidian へのページ保存 | 実装済み(実サービス未確認) | 日報・週報を 1 ページ(記事・ノート)にし、同じ日・週を送り直すと同じページを更新する(対応は `confluence-pages.json` / `esa-pages.json` / `qiitateam-pages.json`)。Confluence は Cloud の REST v2、esa と Qiita Team は記事の API、Obsidian は Vault のフォルダへの直接の書き込み(ネットワークは使わず、セッション終了の通知は日付ごとのノートの末尾に追記)。偽サーバー・一時フォルダとテストでだけ確認している |
| カレンダー(.ics)の書き出し | 実装済み | `GET /api/calendar.ics`、`work-log ical`、画面のリンク。セッションの区間(30 分以上空くと別)ごとに 1 件。外部には送らない。RFC 5545 に合わせている |
| Google カレンダー / Toggl Track / Clockify / Harvest への記録 | 実装済み(実アカウント未確認) | 終わったセッションを記録する。画面は追加・更新・削除の一覧を確認してから送り、CLI(`work-log sync --gcal` / `--toggl` / `--clockify` / `--harvest`)は確認なしで送る(`--dry-run` は表示のみ)。API は `GET` / `POST /api/sync`。記録先は `src/sync/index.js` の一覧に 1 項目足せば増やせる。対応表 `sync-<name>.json` で何度実行しても重複させず、Work Log が作ったもので手元の区間が無くなったものだけ削除する(セッションごと見当たらないものは、終わってから 20 日以内のものだけ)。偽サーバーとテストでだけ確認している |
| メール(SMTP)/ Matrix への送信(日報・週報、セッション終了の通知) | 実装済み(実サーバーで確認) | `report --email` / `--matrix` と画面のボタン。メールは依存なしの SMTP クライアント(`SMTP_URL`、`MAIL_FROM`、`MAIL_TO`。STARTTLS / SMTPS)で、Mailpit v1.31.4 で 3 通りの接続を確認。Matrix は `MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`、`MATRIX_ROOM_ID`(既定は `m.notice`、`m.mentions` は空)で、Synapse 1.162.0 で確認(bob の通知数も)。Gmail・Microsoft 365・SES、Element、公開ホームサーバーは未確認 |
| Redmine / Gitea(Forgejo)の課題連携 | 実装済み(Redmine・Gitea は実サーバーで確認。Forgejo 未確認) | 課題の取得と作業記録コメントの投稿。ID の振り分けは `tasks.redmine.projects` / `keys`、`tasks.gitea.repos`。Redmine の書式は `tasks.redmine.format`(markdown / textile)。Redmine 6.1.5、Gitea 28.0.0 で確認 |
| CalDAV / Redmine の作業時間 / Jira の作業ログへの記録 | CalDAV・Redmine は実装済み(実サーバーで確認)、Jira は実装済み(実サービス未確認) | `work-log sync --caldav` / `--redmine-time` / `--jira-worklog`。CalDAV は ETag と 412 の扱いを Radicale 3.8.1 で確認。Redmine は 6.1.5 で確認。Jira は偽サーバーとテストでだけ確認。Backlog の実績時間は記録先にしない |
| CSV / Excel(.xlsx)の書き出し | 実装済み | `GET /api/export.csv` / `.xlsx`、`work-log export --csv` / `--xlsx`、サイドバーのリンク。1 行は区間かセッション。CSV は式の注入対策つき。openpyxl 3.1.5・pandas・LibreOffice 25.8.7.3 で確認。Excel・Google スプレッドシートは未確認 |
| Prometheus の指標 | 実装済み(Prometheus で確認) | `GET /metrics`(`WORKLOG_METRICS=1` か `metrics.enabled` のときだけ)。Prometheus 3.15.0 と promtool で確認 |
| 利用量・コストのグラフ | 実装済み | ヘッダーの「カレンダー / コスト」で切替。週/月の日別積み上げ棒(モデル系統別)、KPI、モデル別・プロジェクト別の表、コストの大きいセッション。詳細パネルにセッションのコストとトークン数。API 換算額で、定額プランの請求額ではない |

## 非機能要件

| 項目 | 内容 | 状態 |
| --- | --- | --- |
| ローカル完結 | 要約 API 呼び出しのみ例外(オプトイン)。サーバーは 127.0.0.1 のみで待ち受ける | 実装済み |
| 性能 | 数百セッションでも軽快に動く。mtime/size が変わったファイルだけを再解析する差分読み込みとキャッシュを使う | 実装済み |
| 要約のキャッシュ | 同じ内容のセッションを再要約しない | 実装済み |

## 決定事項

- 表示形態: ローカル Web アプリ(ブラウザ表示)。将来 Electron でラップできる。
- 要約モデル: Claude Haiku 4.5(安価・高速)。`WORKLOG_MODEL` で変更できる。
- スマホなど別の端末からは Tailscale 経由で見る(`work-log remote setup`)。サーバーは 127.0.0.1 のまま `tailscale serve` に中継させ、Funnel は使わない。設定したホスト名と(既定で)PC の Tailscale 利用者だけ許し、書き込みは同じ名前の Origin に限る。実際のログイン済み tailnet・実機での確認は未実施。
- 要約はオプトイン: API キー設定時のみ有効。ボタンまたは CLI で明示的に実行する。
- マスキング: 既定で有効。API 送信前と画面表示時に適用する。
- 保存: JSON キャッシュ。SQLite は規模が大きくなった時点で検討する。
- hooks 連携: SessionStart と UserPromptSubmit は async、Stop と SessionEnd は同期で実行する(直後にプロセスが終わると async では記録前に打ち切られるため)。
- hooks はイベントファイル(`events.jsonl`)に追記し、サーバーが追記分だけ取り込む。サーバー停止中のイベントも次回起動時に反映できる。
- Git 連携は読み取り専用(`rev-parse` / `config` / `remote` / `log` のみ、シェル非経由)。紐付けは 2 方式で、ログ上のハッシュ一致(Claude)と、セッション中に同じ作者(`user.email`)が作ったコミット(同時間帯)。
- コストは API で使った場合の換算額。単価表は `src/pricing.js`(価格改定時はここを更新)。単価不明のモデルは合計から除外する。
- サブエージェントのログ(`<セッション>/subagents/*.jsonl`)の利用量は親セッション・親のプロジェクトに合算し、独立したセッションとしては扱わない。
- `stop_reason` のない応答は output_tokens が極端に小さいため、本文の長さから約 2 文字/トークンで見積もり、大きいほうを採る(画面に「一部見積もり」と表示。thinking はログにないので少なめになりうる)。
- Codex ログの形式は openai/codex の codex-rs(rollout / protocol)のソースに準拠する。実際の Codex での動作確認は未実施。
- OpenAI のモデルの単価は組み込まず、利用者が `~/.work-log/pricing.json` に設定する(未設定なら単価不明として合計から除外)。
- hooks では依頼文の本文を保存しない(イベント名、セッション ID、cwd などに限る)。標準出力には何も書かず、常に exit 0 で終わる。
- タスクID の検出とリンクの生成は外部サービスに接続しない。リンク先は、ログにある URL か `config.json` のテンプレートから作る。手動の付け外しは `links.json` に保存する。
- 課題管理サービス(GitHub / GitLab / Linear / Jira / Backlog / Notion)の課題だけ、任意で各サービスの API から情報を取得する。GitHub は `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`(無ければ未認証で公開リポジトリのみ)、GitLab は `GITLAB_TOKEN`(無ければ公開プロジェクトのみ)、Linear は `LINEAR_API_KEY`、Jira は接続先 + `JIRA_EMAIL` / `JIRA_API_TOKEN` か `JIRA_PAT`、Backlog はスペース + `BACKLOG_API_KEY`、Notion は `NOTION_TOKEN` / `NOTION_API_KEY`(キー形式を扱うならデータベースの指定も)。認証情報はサーバー側だけで使い、ブラウザには渡さない。
- 取得した状態は各サービスの状態名で表示し、色は4分類(未着手・進行中・完了・中止/見送り)で付ける。共通部分(キャッシュ、再確認の間隔、API 制限中の停止、同時4件、8秒のタイムアウト)は `src/trackers/base.js` にある。結果は GitHub が `github.json`、ほかは `tracker-<name>.json` にキャッシュする。GitHub と GitLab は ETag で再確認する。
- `ABC-123` 形式のIDの振り分けは、ログ中の URL のホスト、`tasks.<サービス>.keys` のプレフィックス、設定済みのキー形式のサービスが1つだけ、の順。決まらなければリンクのみ(取得しない)。GitLab の `#123` / `!123` は、リポジトリのリモートが設定した GitLab のホストのときだけ取得する。
- 課題への書き込みは作業記録のコメントだけ。投稿する本文を確認ダイアログでそのまま見せ、「投稿する」を押したときだけ投稿する(プレビュー後に内容が変わったら投稿しない)。書式は、GitHub / GitLab / Linear が Markdown、Jira が Wiki 記法、Backlog と Notion が(記法に依らず崩れない)プレーンテキスト。
- Notion は、ページURL(`notion.so` / `*.notion.site`)の検出と、データベースの ID プロパティ(`unique_id`)の値としてのキー形式の両方を扱う。状態は `status` のグループ(To-do / In progress / Complete)で分類し、名前に「中止」「見送り」「cancel」などを含めば中止扱い。コメントは `POST /v1/comments` で、`rich_text` を 2000 文字ずつに分けて投稿する。
- GitLab は実際の公開 API で issue / MR / 見つからない / ETag の再確認まで確認した。Linear / Jira / Backlog / Notion は開発環境から接続できず、公式の SDK / ドキュメントに合わせた偽サーバーとテストでだけ確認している(実 API 未確認。Notion は `@notionhq/client` の型定義、Notion-Version 2025-09-03)。
- Slack 連携: 送り先は `SLACK_WEBHOOK_URL`(https のみ)か、`SLACK_BOT_TOKEN` + チャンネル(`slack.channel` / `SLACK_CHANNEL`)。両方あれば投稿のリンクが取れる Bot を優先する。Webhook の URL とトークンはサーバー側だけで使い、ブラウザには送り先の種類とチャンネル名だけを渡す。
- Discord 連携: 送り先は `DISCORD_WEBHOOK_URL`。Discord の Webhook の URL(`discord.com` / `discordapp.com`、`ptb.` / `canary.`、`/api/v10/` の形)だけを受け付ける(`WORKLOG_DISCORD_WEBHOOK_ANY=1` はテスト用)。`?wait=true` で送り、サーバーのメッセージへのリンクが取れれば画面に出す。embeds で送り(見出し・プロジェクト別・タスク・セッションを各 1 つ、説明 4096 文字・合計 6000 文字・10 個まで。収まらない行は「…ほか n 行」)、Markdown の記号を逃がし、`allowed_mentions` を空にして `@everyone` などで通知が飛ばないようにする。URL はサーバー側だけで使い、ブラウザには送り先が使えるかと表示名だけを渡す。`config.json` の `discord` は `includeCost`、`maxSessions`、`notify`、`username`(既定 `Work Log`)。
- Teams 連携: 送り先は `TEAMS_WEBHOOK_URL`。Workflows(Power Automate の「Webhook 要求を受信したらチャネルに投稿する」)の URL(`*.logic.azure.com` / `*.powerplatform.com`)か、従来の Incoming Webhook の URL(`*.webhook.office.com`。Microsoft が廃止予定)だけを受け付ける(`WORKLOG_TEAMS_WEBHOOK_ANY=1` はテスト用)。Adaptive Card(v1.4、全幅)を `{ type: "message", attachments: [...] }` に包んで送る。TextBlock の Markdown は太字・リスト・リンクだけなので、タイトルなどの `*` `_` `[` `]` は全角に置き換え、セッション一覧は 28KB の制限に収まるよう減らす(「ほか n セッション」)。Teams は投稿へのリンクを返さないので画面に「開く」は出ない。429 は再試行までの秒数つきのエラーにする。画面のボタンは「Teams(Workflows)に送る」(週の集計、プレビュー、確認ダイアログ)。URL はサーバー側だけで使い、ブラウザには送り先が使えるかと表示名だけを渡す。`config.json` の `teams` は `includeCost`、`maxSessions`、`notify`。
- Google Chat 連携: 送り先は `GOOGLE_CHAT_WEBHOOK_URL`。スペースの「アプリと統合」→「Webhook を管理」で作った URL(`https://chat.googleapis.com/v1/spaces/{space}/messages?key=...&token=...`)だけを受け付ける(`WORKLOG_GOOGLE_CHAT_WEBHOOK_ANY=1` はテスト用)。テキストメッセージ `{ text }` で送り、書式は `*太字*` の見出し、`• ` のリスト、`<URL|名前>` のリンク。Chat には記号を逃がす書き方がないので、タイトルなどの `*` `_` `~` `` ` `` `<` `>` `|` は全角に置き換える(`<users/all>` などのメンションも防ぐ)。メッセージは 32,000 バイトまで(Chat API の Message の説明)なので、セッション一覧は収まるよう減らす(「ほか n セッション」)。Webhook の応答には `name` / `thread.name` しか入らず投稿へのリンクは返らないので画面に「開く」は出ない。429 は再試行までの秒数つきのエラー、API のエラーは `error.message` を表示する。画面のボタンは「Google Chat(Webhook)に送る」。URL の `key` / `token` は認証情報なのでサーバー側だけで使い、ブラウザには送り先が使えるかと表示名だけを渡す。`config.json` の `googlechat` は `includeCost`、`maxSessions`、`notify`。
- 日報・週報、セッション終了の通知は、送り先ごとの書式(`src/store.js` の `FORMATS`)で作り、同じ集計を使う。送り先は `target`(`slack` / `discord` / `teams` / `googlechat`)で選ぶ。API は `GET` / `POST /api/report`。`/api/slack/report` は `target=slack` と同じで、互換のために残す。
- 日報・週報は、作業時間を期間に入る部分だけ、コミットを時刻が期間内のものだけ数える。タイムゾーンは画面ではブラウザ、CLI では `--tz` か `TZ`(夏時間に対応)。コストは `includeCost` が `true` のときだけ載せる。Slack は記法の `&` `<` `>` を逃がし、1 セクション 3000 文字以内に分ける。
- 秘匿情報のマスキングは、書式を整える前に行う(Discord の Markdown の記号を逃がすとトークンの形が崩れ、後からでは見つけられないため)。整えた後にもう一度通す。課題へのコメントも同じ。
- 画面からの送信は、確認ダイアログで本文を見せ、「投稿する」を押したときだけ送る(プレビュー後に内容が変わったら送らない)。画面には設定した送り先ごとにボタンを出す。CLI の `report --slack` / `--discord` / `--teams` / `--google-chat` は cron 用に確認なしで送る(併用できる)。
- セッション終了の通知は、`slack.notify` / `discord.notify` / `teams.notify` / `googlechat.notify` が `session_end` の送り先だけ。終了から 2 時間以内のものを 1 件ずつ送り、送った記録を送り先ごとに `slack-notified.json` に残して二度送らない。
- Slack の API は開発環境から接続できず、公式 SDK(`@slack/web-api`、`@slack/webhook`)の形に合わせた偽サーバーとテスト(`test/slack.test.js`)でだけ確認している(実 API 未確認)。
- Discord の API も開発環境から接続できず、discord-api-types の型定義に合わせた偽サーバーとテスト(`test/discord.test.js`)でだけ確認している(実 API 未確認)。
- Teams も開発環境から接続できず、偽サーバーとテスト(`test/teams.test.js`)でだけ確認している(実サービス未確認)。送るデータの形は MicrosoftDocs/msteams-docs(`connectors-using.md`、`cards-format.md`)に合わせている。
- Google Chat も実際のスペースには接続できず、偽サーバーとテスト(`test/googlechat.test.js`)でだけ確認している(実サービス未確認)。送るデータの形と制限は、Chat API の discovery document(`chat.googleapis.com` の `$discovery`、v1)と `@googleapis/chat` に合わせている。
- 拡張点は 3 つの一覧にまとめた。日報・週報の送り先は `src/destinations.js`、ログの取り込み元は `src/sources.js`、カレンダー・工数管理の記録先は `src/sync/index.js`。1 項目足すだけで、CLI のオプション、API、画面、通知に反映される。
- 追加した送り先: Chatwork(`CHATWORK_API_TOKEN` + `CHATWORK_ROOM_ID`、本文は 30000 文字まで)、Mattermost(`MATTERMOST_WEBHOOK_URL`、`https://` の `/hooks/<ID>`、16383 文字まで)、Rocket.Chat(`ROCKETCHAT_WEBHOOK_URL`、`/hooks/<ID>/<token>`、5000 文字まで)、LINE WORKS(`LINEWORKS_*`。Client ID / Secret、サービスアカウント、秘密鍵、Bot ID、チャンネル ID。1900 文字ごとに最大 5 通)。URL・トークン・秘密鍵はサーバー側だけで使い、ブラウザには渡さない。`config.json` の各キーは `includeCost`、`maxSessions`、`notify`(Chatwork は `roomId`、Mattermost は `username` / `iconUrl`、LINE WORKS は `channelId` も)。
- 汎用 Webhook: `WORKLOG_WEBHOOK_URL`(`https://` か手元の `http://`)に `type: "report"` / `type: "session_end"`(`version: 1`)の JSON を POST する。`WORKLOG_WEBHOOK_SECRET` を設定すると `X-WorkLog-Timestamp`(秒)と `X-WorkLog-Signature: sha256=<hex>`(`"<時刻>.<本文>"` の HMAC-SHA256)を付ける。受け取る側は同じ鍵で計算して比べ、古い時刻は捨てる。JSON の形と検証の例は README の「汎用 Webhook」。
- ドキュメント系の送り先(Confluence / esa / Qiita Team / Obsidian)は、期間(`day:2026-10-04` など)と相手側のページの対応をキャッシュのフォルダ(`confluence-pages.json` / `esa-pages.json` / `qiitateam-pages.json`)に覚え、同じ期間を送り直すと同じページを更新する(相手側で消えていれば作り直す)。共通部品は `src/docutil.js`、本文は `src/docreport.js`。セッションは表にして 500 件まで。Confluence は更新のとき `GET` で今のバージョン番号を取って +1 する。esa の更新は `wip` を送らない(Ship it した記事を下書きに戻さないため)。Qiita Team は `<チーム名>.qiita.com` だけに送り、`qiita.com` 本体には送らない。Obsidian は日報 `<日付> 日報.md`、週報 `<年>-W<週> 週報.md` を上書きし、Vault の外(`..`、絶対パス、`.` 始まり、外を指すシンボリックリンク)には書かない。設定は `config.json` の `confluence` / `esa` / `qiitateam` / `obsidian` と、環境変数 `CONFLUENCE_*` / `ESA_*` / `QIITA_*` / `OBSIDIAN_VAULT_DIR`。
- カレンダー(.ics)は外部に送らず、UID を `<セッションID>-<区間の番号>@work-log` で固定して、取り込み直しても重複しないようにする。期間を省くと過去 30 日(最大 366 日)。
- カレンダー・工数管理への記録は、プレビュー(追加・更新・削除の一覧と hash)を見せ、同じ hash のときだけ送る。送ったものは `sync-<name>.json`(予定のキー → 相手側の ID と内容の hash)に記録し、重複させない。削除は、この対応表にあるもので手元の区間が無くなったものだけ。セッションごと見当たらないものは、Claude Code の古いログの自動削除の可能性があるので、終わってから `KEEP_MISSING_AFTER_DAYS`(20 日)以内のものだけ削除する。相手側で消されていたもの(404 / 410)は作り直す。1 件ずつ送り、途中で失敗しても続きから再開できる。設定は `config.json` の `gcal` / `toggl` / `clockify` / `harvest`(共通で `mergeSegments`、`minMinutes`(既定 1))。画面と API の既定は過去 7 日(最大 93 日)。
- 取り込み元の追加: Gemini CLI・Copilot CLI・Aider・Cursor。場所は `WORKLOG_GEMINI_DIR`(`GEMINI_CLI_HOME`)/ `WORKLOG_COPILOT_DIR`(`COPILOT_HOME`)/ `WORKLOG_AIDER_DIRS`(設定したときだけ、3 階層まで探す)/ `WORKLOG_CURSOR_DIR`。Cursor の形式は非公式で、読み取りは `node:sqlite`(Node.js 22.5 以降)の読み取り専用。DB は常に書き換わるのでファイル監視はせず定期スキャンで読む。Gemini の単価は不明のまま(`pricing.json` で設定できる)。
- 動作確認の範囲(追加分): どれも開発環境から実際のアカウント・サービス・ツールに接続できず、偽サーバー・一時フォルダ・サンプルログとテストでだけ確認している。Chatwork は公式の API 定義(chatwork/api の RAML)と `@chatwork/mcp-server`、Mattermost は mattermost/mattermost のソース、Rocket.Chat は Rocket.Chat 7.0.0 のソース、LINE WORKS は公開パッケージ(`nworks`、`chat-adapter-lineworks`、`lineworks-mcp-server`)の実装(公式ドキュメントには届かず未突き合わせ)、Confluence は `confluence.js` 3.2.0 の v2 の定義、esa は `esa-node` 0.2.2 と esa gem 3.7.0、Qiita Team は qiita gem 1.6.0 と `qiita-js` 0.4.3、Google カレンダーは Calendar API v3 の discovery 文書(revision 20260925)、Toggl Track は `toggl-track` 0.9.1 と `toggl-client` 3.7.2、Clockify は `clockify-sdk` 0.1.1 と `clockify-ts` 1.2108.13、Harvest は `harvest-v2` 3.0.0 と `node-harvest-api` 1.0.6、Gemini CLI は `@google/gemini-cli-core` 0.62、Copilot CLI は `@github/copilot` 1.0.63 のスキーマ、Aider は Aider-AI/aider のソース、Cursor は `cursor-history` 0.18 と `cursor-chat-history-mcp` 0.2 に合わせている。未確認の点(エラー応答の形、429 の応答ヘッダー、Harvest の本文の項目名など)は README の「動作確認」に挙げた。
- セキュリティ: Host が 127.0.0.1 / localhost 以外の要求は断る(DNS リバインディング対策)。POST は自分以外の Origin からの要求を断る(CSRF 対策)。フックからの通知は Origin を付けないので通る。
- メール: 依存なしの SMTP クライアント(`node:net` / `node:tls`)。認証情報があるのに TLS にならないときは、手元(`localhost` / `127.0.0.0/8` / `::1`)以外には送らない。From / To / Date / Message-ID は送るときに足す(本文にマスキングをかけるとアドレスが `[EMAIL]` になるため)。本文は常に base64。
- Matrix: 既定の `msgtype` は `m.notice`(既定のプッシュ規則で通知も未読の数も増えない。`matrix.msgtype` で `m.text` にできる)。`"m.mentions": {}` を付けて誰にもメンションしない。429 は同じ `txnId` で送り直して二重投稿を防ぐ。暗号化ルームには送らない。
- Redmine / Gitea の ID の振り分け: Redmine の `#123` は、URL、`tasks.redmine.projects` / `keys`、リポジトリの無いセッションで Redmine を設定していれば Redmine、の順。Gitea の `owner/repo#12` は、URL、`tasks.gitea.repos`、リポジトリのホストが Gitea、の順。Redmine は書式を API から調べられないので `tasks.redmine.format` で指定する。
- 記録先の追加(CalDAV・Redmine・Jira): CalDAV は 1 予定 = 1 ファイル `<キー>.ics` で、ETag と `If-Match` / `If-None-Match` を使い、412 は GET で ETag を取り直して上書き・作り直し(それでも 412 なら止める)。Redmine は `project_id` に数値の ID しか受け付けないので識別子は ID に直し、作業分類が既定に無ければ設定を求める。Redmine・Jira でセッションが課題との紐付けを失っても、送った記録は相手側に残す(削除しない)。
- Backlog の実績時間(`actualHours`)は記録先にしない。課題に 1 つの数値しか無く記録ごとの ID が無いため、人の入力と区別できず、足し引きでは途中で止まると二重に数え、合計で上書きすると人の入力を消す(`src/sync/index.js` のコメント)。
- 書き出し: CSV は UTF-8(BOM 付き)・CRLF・RFC 4180。文字列のセルが `=` `+` `-` `@` タブ CR で始まるときは先頭に `'` を付ける。`.xlsx` は依存なしの自前(インライン文字列のセルなので式にならない)。
- Prometheus の指標: `GET /metrics` は `WORKLOG_METRICS=1` か `metrics.enabled` のときだけ。値は手元のログ全体の累計で、古いログが消えると counter が減ることがある。Docker の Prometheus から取るときは `--network host` が要る。
- 実サーバーで確認したのは、Mailpit v1.31.4、Synapse 1.162.0、Redmine 6.1.5、Gitea 28.0.0、Radicale 3.8.1、Prometheus 3.15.0 / promtool、openpyxl 3.1.5 / pandas / LibreOffice 25.8.7.3(いずれも 2026-10)。見つけて直した不具合は、Redmine の識別子を数値の ID に直す、Redmine に既定の作業分類が無い、Textile の記号を `<notextile>` で逃がす、メールの text の部分を CRLF にする、手元の判定を `127.0.0.0/8` にする、Matrix のルーム v12 の ID(サーバー名の無い形)を受け付ける。Forgejo と Jira の作業ログは未確認(偽サーバーとテストのみ)。詳しくは README の「動作確認」。
