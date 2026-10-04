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
| Codex など他ツールのログ対応 | 実装済み | OpenAI Codex CLI に対応(`~/.codex/sessions/` と `archived_sessions/`、`.jsonl.zst` は Node.js 22.15 以降)。ツールの絞り込みあり。hooks 連携は Claude Code のみ。他のツールは未対応 |
| Slack / Discord 連携(日報・週報、セッション終了の通知) | 実装済み(実 API 未確認) | 画面(週の集計のボタン、確認ダイアログ)と `report` コマンド(`--slack` / `--discord`)から、日報・週報を Slack や Discord に送る。Slack の送り先は Incoming Webhook か Bot トークン + チャンネル、Discord は Webhook。`slack.notify` / `discord.notify` が `session_end` なら、hooks の SessionEnd を受けたセッションを通知する。Slack の API は開発環境から接続できず、公式 SDK に合わせた偽サーバーとテストでだけ確認している。Discord も実 API は未確認で、discord-api-types の型定義に合わせた偽サーバーとテストでだけ確認している |
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
- 日報・週報、セッション終了の通知は、送り先ごとの書式(`src/store.js` の `FORMATS`)で作り、同じ集計を使う。送り先は `target`(`slack` / `discord`)で選ぶ。API は `GET` / `POST /api/report`。`/api/slack/report` は `target=slack` と同じで、互換のために残す。
- 日報・週報は、作業時間を期間に入る部分だけ、コミットを時刻が期間内のものだけ数える。タイムゾーンは画面ではブラウザ、CLI では `--tz` か `TZ`(夏時間に対応)。コストは `includeCost` が `true` のときだけ載せる。Slack は記法の `&` `<` `>` を逃がし、1 セクション 3000 文字以内に分ける。
- 秘匿情報のマスキングは、書式を整える前に行う(Discord の Markdown の記号を逃がすとトークンの形が崩れ、後からでは見つけられないため)。整えた後にもう一度通す。課題へのコメントも同じ。
- 画面からの送信は、確認ダイアログで本文を見せ、「投稿する」を押したときだけ送る(プレビュー後に内容が変わったら送らない)。画面には設定した送り先ごとにボタンを出す。CLI の `report --slack` / `--discord` は cron 用に確認なしで送る(併用できる)。
- セッション終了の通知は、`slack.notify` / `discord.notify` が `session_end` の送り先だけ。終了から 2 時間以内のものを 1 件ずつ送り、送った記録を送り先ごとに `slack-notified.json` に残して二度送らない。
- Slack の API は開発環境から接続できず、公式 SDK(`@slack/web-api`、`@slack/webhook`)の形に合わせた偽サーバーとテスト(`test/slack.test.js`)でだけ確認している(実 API 未確認)。
- Discord の API も開発環境から接続できず、discord-api-types の型定義に合わせた偽サーバーとテスト(`test/discord.test.js`)でだけ確認している(実 API 未確認)。
- セキュリティ: Host が 127.0.0.1 / localhost 以外の要求は断る(DNS リバインディング対策)。POST は自分以外の Origin からの要求を断る(CSRF 対策)。フックからの通知は Origin を付けないので通る。
