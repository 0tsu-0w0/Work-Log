# Work Log

Claude Code の作業履歴を `~/.claude/projects/` 配下の JSONL から自動で収集し、週カレンダーで可視化するローカル Web アプリです。OpenAI Codex CLI のログ(`~/.codex/sessions/`)にも対応し、Gemini CLI・GitHub Copilot CLI・Aider・Cursor のログも読めます。「いつ、どのプロジェクトで何をしていたか」を一目で確認できます。

![週ビューと詳細パネル](docs/screenshot.png)

## 特徴

- 依存パッケージなし(Node.js 20 以上)
- `127.0.0.1` のみで待ち受け。Host が `127.0.0.1` / `localhost` 以外の要求は断ります(DNS リバインディング対策)。書き込み系(POST)は、自分以外の Origin からの要求を断ります(他サイトからの CSRF 対策)。hooks からの通知は Origin を付けないので通ります
- ログは外部に送信しません。LLM 要約だけはオプトインで、送信前に秘匿情報をマスキングします。課題管理サービス(GitHub / GitLab / Linear / Jira / Backlog / Notion / Redmine / Gitea)の課題の情報取得とコメント投稿も任意で、取得はタスクIDの検出結果をもとに各サービスの API へ問い合わせるだけです(「課題管理サービス連携」を参照)。Slack / Discord / Teams / Google Chat / Chatwork / Mattermost / Rocket.Chat / LINE WORKS / Matrix / メール(SMTP)/ 汎用 Webhook / Confluence / esa / Qiita Team / Obsidian への日報・週報の送信も任意で、送るのは利用者が操作したとき(または通知を設定したとき)だけです(「送り先連携」を参照)。Google カレンダー・Toggl Track・Clockify・Harvest・CalDAV・Redmine・Jira への記録も任意で、確認してから送ります(「カレンダーと工数管理」を参照)。`/metrics`(Prometheus 形式)は、有効にしたときだけ 127.0.0.1 に出します
- Claude Code、Codex CLI、Gemini CLI、Copilot CLI、Aider、Cursor のログを、同じカレンダーとコストの画面で扱います(ツールで絞り込めます。「他のツールのログ」を参照)
- ログの変更をファイル監視で検知し、画面を自動更新します
- Claude Code の hooks に登録すると、作業中・入力待ちの状態をリアルタイムに表示します(任意)
- 日報・週報を Slack や Discord、Microsoft Teams、Google Chat、Chatwork、Mattermost、Rocket.Chat、LINE WORKS、Matrix、メール、汎用 Webhook、Confluence、esa、Qiita Team、Obsidian に送れます。セッション終了の通知も任意で設定できます(送り先連携)
- 作業のセッションを `.ics` や CSV / Excel(.xlsx)に書き出したり、Google カレンダー・Toggl Track・Clockify・Harvest・CalDAV・Redmine・Jira に記録したりできます(カレンダーと工数管理)。Prometheus の指標も出せます
- 送り先・ログの取り込み元・記録先は、それぞれ 1 つの一覧(`src/destinations.js` / `src/sources.js` / `src/sync/index.js`)に 1 項目足せば増やせます(「ディレクトリ構成」を参照)

## 使い方

```sh
npm start                          # サーバーを起動 (既定: http://127.0.0.1:4317)
node src/cli.js [--port N]         # ポートを指定して起動
node src/cli.js scan               # ログを解析してセッション一覧をターミナルに表示
node src/cli.js summarize [ID]     # LLM で要約 (ID を省略すると、完了済みで未要約のセッションすべて)
node src/cli.js summarize ID --force   # 要約済みでも再生成
node src/cli.js remote setup|status|off [--port N] [--any-user]  # スマホなど別の端末から Tailscale 経由で開く (「スマホ・別の端末から見る」を参照)
node src/cli.js hooks install      # Claude Code の hooks に登録 (hooks 連携を参照)
node src/cli.js hooks status       # 登録状況を表示
node src/cli.js hooks uninstall    # 登録を削除
node src/cli.js report             # 今日の日報をターミナルに表示 (送り先連携を参照)
node src/cli.js report --week      # 今週の週報を表示
node src/cli.js report --slack     # 表示して、Slack にも送る
node src/cli.js report --discord   # 表示して、Discord にも送る (--slack と併用可)
node src/cli.js report --teams     # 表示して、Teams にも送る (--slack / --discord と併用可)
node src/cli.js report --google-chat  # 表示して、Google Chat にも送る (他の送り先と併用可)
node src/cli.js report --chatwork  # 表示して、Chatwork にも送る (他の送り先と併用可)
node src/cli.js report --mattermost  # Mattermost へ (同上)
node src/cli.js report --rocketchat  # Rocket.Chat へ (同上)
node src/cli.js report --lineworks   # LINE WORKS へ (同上)
node src/cli.js report --webhook     # 汎用 Webhook へ JSON で (同上)
node src/cli.js report --confluence  # Confluence のページに保存 (同上)
node src/cli.js report --esa         # esa の記事に保存 (同上)
node src/cli.js report --qiita-team  # Qiita Team の記事に保存 (同上)
node src/cli.js report --obsidian    # Obsidian の Vault にノートとして保存 (同上)
node src/cli.js report --email       # メールで (同上。SMTP_URL / MAIL_FROM / MAIL_TO)
node src/cli.js report --matrix      # Matrix のルームへ (同上)
node src/cli.js ical [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out file]  # 作業を .ics に書き出す (省くと過去 30 日、標準出力へ。カレンダーと工数管理を参照)
node src/cli.js export --csv|--xlsx [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--per session] [--out file]  # 表計算ソフト向けに書き出す (省くと過去 30 日。CSV は標準出力へ。.xlsx は --out か、端末でない標準出力へ。カレンダーと工数管理を参照)
node src/cli.js sync --gcal|--toggl|--clockify|--harvest|--caldav|--redmine-time|--jira-worklog [--week] [--date YYYY-MM-DD] [--from … --to …] [--tz <IANA名>] [--dry-run]  # 記録先に送る (--dry-run は一覧を表示するだけ)
npm test                           # テストを実行
```

このアプリは手元の PC のログを読み、`127.0.0.1` でだけ待ち受けます。Vercel などのホスティングには置けません(別の端末から見たいときは「スマホ・別の端末から見る(Tailscale)」を参照)。

ポートは `--port`、環境変数 `PORT`、既定値 4317 の順に決まります。`summarize` は `ANTHROPIC_API_KEY` が未設定だとエラー終了します。

## 環境変数

| 変数 | 説明 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 設定すると LLM 要約が有効になります。未設定なら使えません |
| `WORKLOG_MODEL` | 要約に使うモデル。既定は `claude-haiku-4-5-20251001` |
| `WORKLOG_PROJECTS_DIR` | ログの読み取り先。既定は `<CLAUDE_CONFIG_DIR>/projects` |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定ディレクトリ。既定は `~/.claude` |
| `WORKLOG_CODEX_DIR` | Codex のログの読み取り先(その下の `sessions/` と `archived_sessions/`)。未設定なら `CODEX_HOME`、それも無ければ `~/.codex` |
| `CODEX_HOME` | Codex CLI のホームディレクトリ。`WORKLOG_CODEX_DIR` が未設定のときに使います |
| `WORKLOG_GEMINI_DIR` | Gemini CLI のログの読み取り先(その下の `tmp/`)。未設定なら `$GEMINI_CLI_HOME/.gemini`、それも無ければ `~/.gemini` |
| `GEMINI_CLI_HOME` | Gemini CLI のホームディレクトリ。`WORKLOG_GEMINI_DIR` が未設定のときに使います |
| `WORKLOG_COPILOT_DIR` | Copilot CLI のログの読み取り先(その下の `session-state/`)。未設定なら `COPILOT_HOME`、それも無ければ `~/.copilot` |
| `COPILOT_HOME` | Copilot CLI のホームディレクトリ。`WORKLOG_COPILOT_DIR` が未設定のときに使います |
| `WORKLOG_AIDER_DIRS` | Aider の履歴を探すフォルダ(パス区切りで複数可)。設定したときだけ Aider のログを読みます |
| `WORKLOG_CURSOR_DIR` | Cursor のユーザーデータ(`…/Cursor/User`)。未設定なら OS ごとの既定の場所 |
| `WORKLOG_CACHE_DIR` | キャッシュの保存先。既定は `~/.work-log` |
| `WORKLOG_NO_MASK=1` | 画面表示時のマスキングを無効にします |
| `GITHUB_TOKEN` | GitHub API のトークン。issue / PR の情報取得とコメント投稿に使います。最優先です |
| `GH_TOKEN` | `GITHUB_TOKEN` が未設定のときに使うトークン |
| `WORKLOG_GITHUB_NO_GH=1` | トークンが環境変数に無いとき、GitHub CLI(`gh auth token`)を呼びません |
| `WORKLOG_GITHUB_API` | GitHub API の URL。既定は `https://api.github.com` |
| `GITLAB_TOKEN` | GitLab のトークン(`PRIVATE-TOKEN` ヘッダーで送ります)。無くても公開プロジェクトは読めます |
| `GITLAB_URL` | GitLab の接続先。既定は `https://gitlab.com`(`tasks.gitlab.baseUrl` が優先) |
| `LINEAR_API_KEY` | Linear の個人 API キー。未設定なら Linear には問い合わせません |
| `JIRA_BASE_URL` | Jira の URL(`tasks.jira.baseUrl` が優先)。未設定なら Jira には問い合わせません |
| `JIRA_EMAIL` | Jira Cloud のメールアドレス。`JIRA_API_TOKEN` と組で使います |
| `JIRA_API_TOKEN` | Jira Cloud の API トークン |
| `JIRA_PAT` | Jira Server / Data Center の個人アクセストークン |
| `BACKLOG_SPACE` | Backlog のスペース(例: `<space>.backlog.jp`。`tasks.backlog.space` が優先) |
| `BACKLOG_API_KEY` | Backlog の API キー(`Backlog-API-Key` ヘッダーで送ります) |
| `WORKLOG_LINEAR_API` | Linear の API の URL。主にテスト用です。既定は `https://api.linear.app/graphql` |
| `WORKLOG_BACKLOG_API` | Backlog の API のベース URL。主にテスト用です。既定は `https://<スペース>/api/v2` |
| `NOTION_TOKEN` | Notion のインテグレーションのシークレット(Bearer で送ります)。未設定なら Notion には問い合わせません |
| `NOTION_API_KEY` | `NOTION_TOKEN` が未設定のときに使うシークレット |
| `NOTION_DATABASE_ID` | キー形式(`TASK-12`)を探す Notion データベースの ID(`tasks.notion.databaseId` が優先) |
| `NOTION_DATA_SOURCE_ID` | 同じく Notion のデータソースの ID(`tasks.notion.dataSourceId` が優先) |
| `WORKLOG_NOTION_API` | Notion の API のベース URL。主にテスト用です。既定は `https://api.notion.com` |
| `SLACK_WEBHOOK_URL` | Slack の Incoming Webhook の URL。`https://` のものだけ使います |
| `SLACK_BOT_TOKEN` | Slack の Bot トークン。送り先のチャンネルと組で使います |
| `SLACK_CHANNEL` | Bot で投稿するチャンネル(`slack.channel` が優先) |
| `WORKLOG_SLACK_API` | Slack の Web API のベース URL。主にテスト用です。既定は `https://slack.com/api` |
| `DISCORD_WEBHOOK_URL` | Discord の Webhook の URL。Discord の Webhook の URL だけ使います |
| `WORKLOG_DISCORD_WEBHOOK_ANY=1` | `DISCORD_WEBHOOK_URL` に Discord 以外の URL も許します。テスト用です |
| `TEAMS_WEBHOOK_URL` | Teams の Workflows(Power Automate)の Webhook の URL か、従来の Incoming Webhook の URL。Microsoft の Webhook の URL だけ使います |
| `WORKLOG_TEAMS_WEBHOOK_ANY=1` | `TEAMS_WEBHOOK_URL` に Microsoft 以外の URL も許します。テスト用です |
| `GOOGLE_CHAT_WEBHOOK_URL` | Google Chat のスペースの Webhook の URL(スペースの「アプリと統合」→「Webhook を管理」で作ります)。`chat.googleapis.com` の URL だけ使います |
| `WORKLOG_GOOGLE_CHAT_WEBHOOK_ANY=1` | `GOOGLE_CHAT_WEBHOOK_URL` に Google 以外の URL も許します。テスト用です |
| `CHATWORK_API_TOKEN` | Chatwork の API トークン(`X-ChatWorkToken` ヘッダーで送ります) |
| `CHATWORK_ROOM_ID` | 送り先のルーム ID(`chatwork.roomId` でも指定できます) |
| `MATTERMOST_WEBHOOK_URL` | Mattermost の Incoming Webhook の URL(`https://<host>/hooks/<ID>`)。`https://` のものだけ使います |
| `WORKLOG_MATTERMOST_WEBHOOK_ANY=1` | `MATTERMOST_WEBHOOK_URL` に http の URL や上記の形以外の URL も許します。テスト用です |
| `ROCKETCHAT_WEBHOOK_URL` | Rocket.Chat の Incoming Webhook の URL(`https://<host>/hooks/<ID>/<token>`)。`https://` のものだけ使います |
| `WORKLOG_ROCKETCHAT_WEBHOOK_ANY=1` | `ROCKETCHAT_WEBHOOK_URL` に http の URL や上記の形以外の URL も許します。テスト用です |
| `LINEWORKS_CLIENT_ID` | LINE WORKS の Client ID |
| `LINEWORKS_CLIENT_SECRET` | LINE WORKS の Client Secret |
| `LINEWORKS_SERVICE_ACCOUNT` | LINE WORKS のサービスアカウント |
| `LINEWORKS_PRIVATE_KEY` | サービスアカウントの秘密鍵(PEM。改行は `\n` でもよい) |
| `LINEWORKS_PRIVATE_KEY_FILE` | 秘密鍵のファイルのパス(`LINEWORKS_PRIVATE_KEY` の代わり) |
| `LINEWORKS_BOT_ID` | 送信に使う Bot の ID |
| `LINEWORKS_CHANNEL_ID` | 送り先のトークルームのチャンネル ID(`lineworks.channelId` でも指定できます) |
| `WORKLOG_LINEWORKS_AUTH` | LINE WORKS のトークン取得先 URL。主にテスト用です |
| `WORKLOG_LINEWORKS_API` | LINE WORKS の API の基点 URL。主にテスト用です |
| `WORKLOG_WEBHOOK_URL` | 汎用 Webhook の URL。`https://` か、手元の受け口(`localhost` / `127.0.0.1` / `::1`)の `http://` だけ使います |
| `WORKLOG_WEBHOOK_SECRET` | 設定すると、汎用 Webhook に HMAC-SHA256 の署名を付けます(「汎用 Webhook」を参照) |
| `CONFLUENCE_BASE_URL` | Confluence Cloud の URL(`https://<site>.atlassian.net`)。`atlassian.net` のものだけ使います |
| `CONFLUENCE_EMAIL` | Confluence のメールアドレス。`CONFLUENCE_API_TOKEN` と組で使います |
| `CONFLUENCE_API_TOKEN` | Confluence の API トークン |
| `CONFLUENCE_SPACE_ID` | ページを作るスペースの ID(数字。`confluence.spaceId` でも指定できます) |
| `CONFLUENCE_PARENT_ID` | 親ページの ID(任意。数字。`confluence.parentId` でも指定できます) |
| `WORKLOG_CONFLUENCE_BASE_ANY=1` | `CONFLUENCE_BASE_URL` に `atlassian.net` 以外も許します。テスト用です |
| `ESA_ACCESS_TOKEN` | esa のアクセストークン(Bearer で送ります) |
| `ESA_TEAM` | esa のチーム名(`esa.team` でも指定できます) |
| `QIITA_ACCESS_TOKEN` | Qiita Team のアクセストークン(Bearer で送ります) |
| `QIITA_TEAM_DOMAIN` | Qiita Team のドメイン(`<チーム名>.qiita.com`)。`qiita.com` 本体には送りません |
| `OBSIDIAN_VAULT_DIR` | Obsidian の Vault のフォルダ(`obsidian.vault` でも指定できます) |
| `GOOGLE_CLIENT_ID` | Google カレンダーへの記録に使う OAuth のクライアント ID |
| `GOOGLE_CLIENT_SECRET` | 同じくクライアントシークレット |
| `GOOGLE_REFRESH_TOKEN` | 同じくリフレッシュトークン(`calendar.events` か `calendar.app.created` のスコープ) |
| `GOOGLE_CALENDAR_ID` | 記録先のカレンダーの ID(`gcal.calendarId` でも指定できます) |
| `WORKLOG_GCAL_TOKEN_URL` | Google の OAuth のトークン取得先 URL。主にテスト用です |
| `TOGGL_API_TOKEN` | Toggl Track の API トークン |
| `CLOCKIFY_API_KEY` | Clockify の API キー(`X-Api-Key` ヘッダーで送ります) |
| `WORKLOG_CLOCKIFY_API` | Clockify の API の URL。主にテスト用です(`clockify.baseUrl` でも変えられます) |
| `HARVEST_ACCESS_TOKEN` | Harvest の Personal Access Token |
| `HARVEST_ACCOUNT_ID` | Harvest のアカウント ID |
| `SMTP_URL` | メール送信の SMTP サーバー。`smtp://user:pass@host:587`(STARTTLS)か `smtps://user:pass@host:465`(最初から TLS)。ユーザー名とパスワードは URL エンコードして書きます |
| `MAIL_FROM` | メールの差出人(`email.from` が優先) |
| `MAIL_TO` | メールの宛先。カンマ区切りで複数(`email.to` が優先) |
| `WORKLOG_SMTP_SECURE=1` | `smtp://` でも最初から TLS で話します(465 番は URL に関係なく最初から TLS) |
| `WORKLOG_SMTP_INSECURE=1` | SMTP の証明書を確かめません。手元のテスト用です。自己署名の CA は `NODE_EXTRA_CA_CERTS` で足せます |
| `MATRIX_HOMESERVER` | Matrix のホームサーバーの URL。`https` のもの(`http` は `localhost` / `127.0.0.1` / `::1` だけ) |
| `MATRIX_ACCESS_TOKEN` | Matrix のアクセストークン(Bearer で送ります) |
| `MATRIX_ROOM_ID` | 送り先のルーム ID(`!` で始まるもの。`#別名` は使えません。`matrix.roomId` が優先) |
| `REDMINE_URL` | Redmine の URL(`tasks.redmine.baseUrl` が優先)。課題の取得と作業時間の記録に使います |
| `REDMINE_API_KEY` | Redmine の API キー(`X-Redmine-API-Key` ヘッダーで送ります)。作業時間の記録はこの鍵の利用者のものになります |
| `WORKLOG_REDMINE_API` | 作業時間の記録先の Redmine の URL。主にテスト用です |
| `GITEA_URL` | Gitea / Forgejo の URL(`tasks.gitea.baseUrl` が優先。`FORGEJO_URL` でも可) |
| `GITEA_TOKEN` | Gitea / Forgejo のアクセストークン(`Authorization: token` で送ります。`FORGEJO_TOKEN` でも可) |
| `CALDAV_URL` | CalDAV のカレンダーのコレクションの URL(`caldav.url` でも可) |
| `CALDAV_USERNAME` | CalDAV の Basic 認証のユーザー名 |
| `CALDAV_PASSWORD` | CalDAV の Basic 認証のパスワード(アプリパスワード推奨) |
| `WORKLOG_REMOTE_HOSTS` / `WORKLOG_REMOTE_USERS` | Tailscale 経由で開いてよいホスト名・利用者(カンマ区切り。`config.json` の `remote` に足されます。「スマホ・別の端末から見る」を参照) |
| `WORKLOG_METRICS=1` | `GET /metrics`(Prometheus 形式)を有効にします(`config.json` の `metrics.enabled` でも可) |
| `PORT` | 待ち受けポート(`--port` が優先) |

## スマホ・別の端末から見る(Tailscale)

Work Log は手元の PC のログを読み、`127.0.0.1` でだけ待ち受けるので、Vercel などにデプロイして使うものではありません。スマホなど自分の別の端末から見るには、[Tailscale](https://tailscale.com/) の `tailscale serve` で、PC のサーバーを tailnet の中だけに HTTPS で中継します。

### 準備

- PC とスマホの両方に Tailscale を入れ、同じ tailnet にログインします。
- Tailscale の管理画面(admin console)で、MagicDNS と HTTPS 証明書を有効にします。

### 手順

```sh
node src/cli.js                    # サーバーを起動 (npm start でも可)
node src/cli.js remote setup       # 別のターミナルで。https://<PC の名前>.<tailnet>.ts.net/ を表示します
```

表示された URL をスマホのブラウザで開きます。

- `remote status`: 設定済みの名前と、開ける利用者を表示します。
- `remote off`: `tailscale serve` を止め、`config.json` の `remote` を空にします。
- `--port N`: サーバーのポートが 4317 以外のときに付けます。
- `--any-user`: tailnet の誰でも開けるようにします(既定は、この PC にログインしている Tailscale の利用者だけ)。

### 安全面

- サーバーは `127.0.0.1` のままです。`tailscale serve` が HTTPS で中継し、開けるのは tailnet の中だけです。
- `config.json` の `remote.hosts` にある名前の Host だけを受け付けます(DNS リバインディング対策)。
- 既定では、この PC にログインしている Tailscale の利用者(`remote.users`)だけが開けます。`Tailscale-User-Login` ヘッダーで判定します。`tailscale serve` は、送り手が付けたこのヘッダーを消してから付け直します(tailscale v1.102.5 のソース `ipn/ipnlocal/serve.go` で確認)。
- Funnel(インターネット公開)経由の要求は断ります。`tailscale funnel` は使わないでください。
- 書き込み(POST)は、Origin が `https://<その名前>` のときだけ通します。
- フックの受け口(`/api/hook`)、`/api/rescan`、`/metrics` は、この PC の中からだけ使えます。
- 設定は `config.json` の `remote`(`{ "hosts": ["pc.tailXXXX.ts.net"], "users": ["me@example.com"] }`)に入ります。環境変数 `WORKLOG_REMOTE_HOSTS` / `WORKLOG_REMOTE_USERS`(カンマ区切り)でも足せます。

### 動かし続ける

PC が起きていて、`work-log` が動いている間だけ見られます。ログイン時に自動で起動したいときは、launchd(macOS)、systemd(Linux)、タスクスケジューラ(Windows)に登録してください(設定ファイルはまだ用意していません)。

### スマホでの画面

- カレンダーは枠の中で横にスクロールします。時刻の列と日付の見出しは固定です。
- ブロックを押すと詳細が画面いっぱいに開き、「← 週の集計」で戻ります。
- コストやタスクの表は、表だけが枠の中でスクロールします。

### 動作確認

- 単体・結合テスト(`test/remote.test.js`)で確認しています。
- 本物の `tailscale status --json`(tailscale 1.102.5。ログイン前の NeedsLogin は実際の tailscaled から取得)と同じ形を返す偽の `tailscale` コマンドで、`remote` コマンドを確認しています。
- `tailscale serve` と同じヘッダーの動きをまねるローカルの HTTPS リバースプロキシ越しに、スマホの大きさの Chromium で、ページの表示、SSE、日報の送信、別の利用者での 403 を確認しています。
- 本物のログイン済みの tailnet と、実機のスマホでは確認していません。

## Codex 対応

OpenAI Codex CLI のセッションログを、Claude Code と同じ集計レコードにして表示します。Codex が無い環境ではフォルダが存在しないだけで、何も起きません。

形式は openai/codex リポジトリの codex-rs(rollout / protocol)のソースに合わせて実装しています。実際の Codex を動かしての確認はしていません(この開発環境では OpenAI の API に接続できないため)。

### 読み取り先

- `$WORKLOG_CODEX_DIR` → `$CODEX_HOME` → `~/.codex` の順に決め、その下の `sessions/YYYY/MM/DD/rollout-*.jsonl` と `archived_sessions/` を読みます。
- Codex は 7 日以上前のログを `.jsonl.zst` に圧縮します。圧縮ログは Node.js 22.15 以降なら読めます。それ未満では警告を出して読み飛ばします。
- 同じログの圧縮版と未圧縮版が両方あるときは、未圧縮版を使います。
- 旧形式(行に `type` / `payload` の包みが無いログ)も読みます。

### 抽出する内容

- 依頼: `event_msg` の `user_message` です。無い古いログは、`response_item` のユーザーメッセージから拾います。Codex が差し込む `<environment_context>` などは除外します。
- 応答数: アシスタントのメッセージ数です。
- 変更ファイル: `apply_patch` の対象ファイルです。
- コマンド: シェル系ツールのコマンドです。`git commit` / `git push` も数えます。結果が `exec_command_end` と `function_call_output` の両方に出ても、1 回だけ数えます。
- モデル: `turn_context` から取ります。
- ブランチ: `session_meta` の git 情報から取ります。
- 利用量: `token_usage_record` があればそれを使います。無ければ `token_count` を、累計が増えたときだけ数えます。`input_tokens` からキャッシュ分を引き、`output_tokens` は推論トークンを含む値のまま使います。

### 画面での扱い

- ツールが 2 種類以上あると、ヘッダーに「すべてのツール / Claude Code / Codex / …」の絞り込みが出ます(他のツールも含みます)。カレンダー、検索、コストに効きます。
- Codex のブロックは、斜線のテクスチャとメタ行の「Codex」で見分けます。詳細パネルにはツールのバッジを表示します。
- コストのグラフでは「OpenAI」系統として表示します。単価は利用者が設定します(「コスト」の「単価表の上書き」を参照)。
- hooks 連携と、LLM 要約の hooks 部分は Claude Code のみです。Codex には hooks が無いため、状態はログの更新時刻で判定します。
- Git 連携は Codex のセッションにも効きます。

## 他のツールのログ(Gemini CLI / Copilot CLI / Aider / Cursor)

Codex と同じように、次のツールのログも同じ集計レコードにして、カレンダー・コスト・日報に出します。ログの場所が無い環境では、何も起きません。取り込み元は `src/sources.js` の一覧にあり、1 つ足せば増やせます。

| ツール | 読み取り先(既定) | 場所を変える環境変数 |
| --- | --- | --- |
| Gemini CLI | `~/.gemini/tmp/<プロジェクトID>/chats/session-*.jsonl`(古い版は `.json`)。`GEMINI_CLI_HOME` があればその下の `.gemini` | `WORKLOG_GEMINI_DIR` |
| Copilot CLI | `~/.copilot/session-state/<ID>/events.jsonl`(と `workspace.yaml`)。古い版は `history-session-state/*.json`。`COPILOT_HOME` があればその下 | `WORKLOG_COPILOT_DIR` |
| Aider | 各リポジトリの `.aider.chat.history.md`(あれば `.aider.input.history`) | `WORKLOG_AIDER_DIRS`(パス区切りで複数) |
| Cursor | `…/Cursor/User/globalStorage/state.vscdb`(Linux は `~/.config`、macOS は `~/Library/Application Support`、Windows は `%APPDATA%` の下) | `WORKLOG_CURSOR_DIR` |

- Gemini CLI: 1 行目のメタ情報と、以降のメッセージ(同じ ID のメッセージは後の行が正)を読みます。サブエージェント(`chats/<親セッションID>/`)も読みます。`logs.json` は入力した依頼だけの記録なので、`chats` が無いセッションに限って補助的に使います。2026-10-04 に実際の Gemini CLI 0.62.0 で書かれたログで確認済みです(下の「動作確認」)。モデルの振り分けの呼び出しは `chats` のログに残らないため、そのトークンは数えられません。
- Copilot CLI: `session.start` / `user.message` / `assistant.message` / `session.shutdown` などのイベントを読みます。応答ごとの利用量(`assistant.usage`)はファイルに残らないので、終了時のモデルごとの利用量を使います。この利用量は再開をまたいで累積されるため、二重に数えないよう差し引いています。実際の Copilot CLI 1.0.91 のログで確認済みです。
- Aider: 中央の保存場所が無いので、`WORKLOG_AIDER_DIRS` に挙げたフォルダの下を 3 階層まで探します。設定しないと読みません。依頼ごとの時刻は `.aider.input.history` からしか取れないため、あれば使います。実際の Aider 0.86.2 のログで確認済みです。
- Cursor: Cursor の保存形式は公開されていません。ここで読んでいる形は、読み取りツール(`cursor-history`、`cursor-chat-history-mcp`)の実装から調べた非公式のもので、Cursor の更新で変わることがあります。SQLite は Node.js 標準の `node:sqlite`(Node.js 22.5 以降)で読み取り専用に開くので、それ未満では何も読みません。DB は常に書き換わるため、ファイル監視はせず、定期スキャンで読みます。
- コスト: Gemini のモデルの単価は組み込んでいません。`~/.work-log/pricing.json` に書かない限り、単価不明として合計から除外します(「コスト」の「単価表の上書き」を参照)。
- 画面の絞り込みや日報の「(ツール名)」の印は、Codex と同じように働きます。hooks 連携は Claude Code のみです。

形式は、各ツールの公開ソース・スキーマに合わせて実装し、Codex CLI・Gemini CLI・Copilot CLI・Aider は実際のツールが書いたログでも確認しました(Cursor は未確認)。確認の範囲は、「送り先連携」の「動作確認」にまとめています。

## 画面

- 週ビュー: 縦軸が時間、横軸が曜日(月曜始まり)です。日付の見出しにはその日の作業時間の合計が出ます。
- ブロック: セッションのアクティビティ区間です。30 分以上の空白があるとブロックを分けます。色はプロジェクトごとに決まります。重なるブロックは横に並べて表示します。
- 状態: hooks 連携が有効なときは「作業中」「入力待ち」「完了」を表示します(詳細は「hooks 連携」)。hooks 未設定のときは、ログの最終更新から 5 分以内のセッションを「作業中」、それ以外を「完了」とみなします。作業中のセッションは、最後のブロックを現在時刻まで伸ばして表示します。
- ヘッダーのバッジ: hooks が登録済みなら「hooks連携中」、未登録なら「hooks未設定」と表示します。
- 詳細パネル: ブロックをクリックすると表示します。状態、作業種別、コンポーネント、期間、コミット数、変更ファイル数、メッセージ数、要約、変更ファイル一覧、最初の依頼、使用ツール、トークン数、モデル、API 換算コストを確認できます。コスト行には、サブエージェント分の件数と金額の内訳も出ます(「コスト」を参照)。hooks のイベントがあるセッションでは、開始種別、終了理由、最終イベントも表示します。何も選んでいないときは、その週のプロジェクト別作業時間と、週に動いたセッションの API 換算コストの合計(週をまたぐセッションは全体の額)を表示します。
- フィルタ: プロジェクトとタグ(作業種別・コンポーネント)で絞り込めます。詳細パネルのタグをクリックしても絞り込めます。
- キーワード検索: 全期間が対象です。タイトル、要約、プロジェクト名、ブランチ名、依頼文、変更ファイル、コンポーネントを検索します。結果をクリックすると該当の週に移動します。
- 自動更新: ログディレクトリを監視し、変化があれば差分スキャンして画面を更新します。60 秒ごとにも再確認するので、「作業中」から「完了」への切り替えも反映されます。hooks 連携が有効なら、イベントの受信でも即時に更新します。

## コスト

ヘッダーの「カレンダー / コスト」で表示を切り替えます。コストビューは「週 / 月」を切り替えられ、‹ › で期間を移動します。プロジェクトとツールのフィルタが効きます(タグは効きません)。

- KPI: 合計、作業日あたり、トークン、キャッシュヒット率です。キャッシュヒット率は、入力側(入力、キャッシュ読込、キャッシュ書込)のうちキャッシュ読込の割合です。
- 日別の積み上げ棒: モデル系統(Opus / Sonnet / Haiku / Fable / OpenAI / その他)別です。色は系統に固定です。ホバーすると内訳を表示します。
- 表: モデル別とプロジェクト別です。コスト、割合、入力・出力・キャッシュ読込・キャッシュ書込のトークン数を表示します。
- コストの大きいセッション: 上位 10 件です。クリックすると詳細パネルを開きます。詳細パネルには、そのセッションの API 換算コストを表示します。サブエージェントを含む場合は、その件数と金額を併記します。

注意: 表示するのは API で使った場合の換算額です。Pro / Max などの定額プランの請求額ではありません。単価は `src/pricing.js` の表(公式価格ページ、2026-10-04 時点)で、価格が改定されたらここを更新します。

### 計算方法

- 入力、出力、キャッシュ読込(モデルごとの実額)、キャッシュ書込を計上します。キャッシュ書込は 5 分が入力単価の 1.25 倍、1 時間が 2 倍です。内訳のない古いログは 5 分として扱います。
- fast モードは、対応モデル(Opus 5.5 / 5 / 4.8)の fast 用の単価で計算します。キャッシュの倍率はその単価に掛かります。
- `inference_geo` が `us` の応答は、4.6 以降のモデルで 1.1 倍にします。
- Web 検索は 1,000 回あたり $10 です。
- モデル ID は、日付付き(`claude-opus-4-5-20251101` など)、`[1m]` 付き、Bedrock 形式(`anthropic.claude-…`)でも単価表に当てます。
- 単価表にないモデルは「単価不明」と表示し、合計から除外します。`<synthetic>` などの API を呼んでいない応答は数えません。

### 単価表の上書き

`~/.work-log/pricing.json`(`WORKLOG_CACHE_DIR` 配下)に単価を書くと、組み込みの表より優先して使います。OpenAI のモデルの単価は組み込んでいないため、Codex のコストを出すにはここに書きます(書かないと「単価不明」として表示し、合計から除外します)。Claude の単価の上書き(価格改定への追従)にも使えます。

```json
{
  "<モデルIDの前方一致>": { "input": 入力単価, "output": 出力単価, "cacheRead": キャッシュ読込単価, "cacheWrite": キャッシュ書込単価 }
}
```

- 単位は USD / 100 万トークンです。キーはモデル ID の前方一致で、長いキーが優先されます。
- `cacheRead` を省くと入力単価の 0.1 倍です。`cacheWrite` を省くと、5 分が入力単価の 1.25 倍、1 時間が 2 倍です。
- 値は公式の価格ページで確認して書いてください。
- ファイルは解析のたびに読み直します。読めない場合は警告を出し、組み込みの単価だけを使います。

### 集計

- 利用量は、1 時間・モデル単位(UTC)で解析結果に保持します。日付への振り分けは、ブラウザのタイムゾーンで行います。
- サブエージェントのログ(`<セッション>/subagents/*.jsonl`)の利用量は、親セッションと親のプロジェクトに合算します。独立したセッションとしては表示しません。

### 精度の注意

- 1 つの応答がログの複数行に分かれているときは、最後の usage を採ります。
- `stop_reason` のない応答(サブエージェントのログで確認)は、ストリーム開始時点の usage しか残らず、`output_tokens` が極端に小さくなります。そのため、本文(テキストとツール入力)の長さから約 2 文字 = 1 トークンで出力を見積もり、記録値より大きければそちらを使います。見積もりを使った分は、画面に「一部見積もり」と表示します。
- thinking の本文はログに残らないため、見積もりは実際より少なめになることがあります。

## hooks 連携

Claude Code の hooks に登録すると、セッションの開始・依頼の送信・応答の完了・終了を検知し、状態をリアルタイムに表示できます。登録しなくても、ログの解析だけで動きます。

```sh
node src/cli.js hooks install                       # 登録
node src/cli.js hooks install --dry-run             # 書き込まず、登録内容だけ表示
node src/cli.js hooks install --settings PATH       # 対象の settings.json を指定
node src/cli.js hooks status                        # 登録済みのイベントを表示
node src/cli.js hooks uninstall                     # 登録を削除
```

- 登録先: `$CLAUDE_CONFIG_DIR/settings.json`(既定は `~/.claude/settings.json`)。`--settings` で変更できます。`status` と `uninstall` にも使えます。
- 既存の設定とほかのフックはそのまま残します。書き換える前に `settings.json.work-log.bak` を作ります。settings.json が壊れた JSON のときは、何も変更せず中止します。
- 登録するイベント: `SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd`
  - `SessionStart` と `UserPromptSubmit` は async で実行し、Claude Code を待たせません。
  - `Stop` と `SessionEnd` は同期で実行します(タイムアウト 5 秒)。`claude -p` などは直後にプロセスが終わるため、async だと記録前に打ち切られることを実機で確認しています。応答の表示後に約 0.2 秒かかります。
- 登録するコマンドは `node "<絶対パス>/src/cli.js" hook --work-log` です。末尾の `--work-log` で自分のフックを識別するので、リポジトリを移動したら `hooks install` をやり直せば置き換わります。`node` が PATH にある必要があります。

### 仕組み

1. フックは stdin の JSON から必要な項目(イベント名、セッション ID、cwd、トランスクリプトのパス、開始種別、終了理由)だけを `~/.work-log/events.jsonl` に追記します。依頼文の本文は保存しません。
2. 起動中のサーバーがあれば、`server.json` に書かれたポートへ通知します(`POST /api/hook`)。
3. サーバーは `events.jsonl` の追記分だけを取り込み、画面を即時に更新します。サーバー停止中のイベントは、次回の起動時に取り込みます。

フックは標準出力に何も書かず、失敗しても常に exit 0 で終わるので、Claude Code の動作を妨げません。`events.jsonl` は 5MB を超えると、取り込み後に作り直します。

### 状態の表示

- 作業中: `UserPromptSubmit` の後です。
- 入力待ち: `Stop` の後、または `SessionStart` の後です。
- 完了: `SessionEnd` を受けたとき、または最後のアクティビティ(ログの更新とフックのイベントの新しいほう)から 30 分経ったときです。端末を閉じたりクラッシュしたりして終了イベントが来ない場合も、完了になります。

詳細パネルには、開始種別、終了理由、最終イベントを表示します。

### 注意

Claude Code on the web などのクラウドセッションは、ユーザーの `~/.claude/settings.json` を読みません。この連携はローカルの Claude Code 向けです。

## Git 連携

詳細パネルを開いたとき、セッションの作業ディレクトリのリポジトリを読み、コミットをセッションに紐付けます。読み取り専用の `rev-parse` / `config` / `remote` / `log` だけを、シェルを介さずに実行します(タイムアウト 5 秒)。

- 種類:
  - 「Claude」: ログ上のハッシュと一致するコミット、または `-q` コミットの実行時刻から 2 分以内のコミットです。
  - 「同時間帯」: セッションの各区間の 2 分前から 10 分後までに、そのリポジトリの `user.email` と同じ作者が作ったコミットです。`--all` で全ブランチを対象にします。同僚のコミットは除外します。
- ログにあるがリポジトリに見つからないコミット(amend や rebase で書き換えた、別のマシンで作った、など)は「見つかりません」と表示します。
- 作業中のセッションは、現在時刻までを対象にします。
- 表示内容: 短縮ハッシュ、件名、時刻、作者、ファイル数、+追加/−削除、合計です。リモートが GitHub / GitLab / Bitbucket なら、ハッシュはコミットページへのリンクになります。URL 中の認証情報は落とします。作者のメールアドレスは画面に返しません。
- 結果は 60 秒キャッシュします。
- リポジトリがない、または git がない場合は、ログから抽出したコミットだけを表示します。
- 週の集計にコミット数を表示します。キーワード検索では、コミットのハッシュと件名も検索できます。

## タスク管理連携

ログの中にあるタスクIDを見つけて、セッションに紐付けます。ID の検出とリンクの生成は、外部サービスに接続しません。解決できた課題についてだけ、任意で各サービスの API から情報を取得します(「課題管理サービス連携」を参照)。

### 拾う場所と形式

- 場所: 依頼文、ブランチ名、コミットの件名(Claude Code や Codex が実行して成功したもの)です。
- 形式: `ABC-123`、`#123`、`owner/repo#123`、`GH-123`、`!123`、`group/project!123`、GitHub の issue / PR の URL、GitLab の issue / MR の URL(`…/-/issues/123`、`…/-/merge_requests/123`)、Linear の issue URL、Jira の browse URL、Backlog の `/view/` URL、Notion のページ URL です。ブランチ名は `123-xxx`、`feature/123-xxx`、`fix/ABC-123-xxx` の形を拾います。
- `!123` と `group/project!123` は GitLab のマージリクエストです。セッションのリポジトリが GitLab でなければ、解決の段階で捨てます(GitHub のリポジトリでは意味が無いため)。
- `ABC-123` のプレフィックスには `_` も使えます(`MY_APP-12` など)。ブランチ名では `_` を区切りとして扱うので、`_` を含むキーは拾いません。
- GitLab の URL はグループを入れ子にできるため、`/-/` の手前までをプロジェクトのパスとみなします(サブグループ対応)。
- Notion のページ URL は `www.notion.so` / `notion.so` / `<サイト>.notion.site` のものを拾います。ページ ID は、URL 末尾の32桁の16進数か、データベースから開いたときの `?p=<32桁>` です。URL の中のタイトル部分(`Fix-login-` など)は、ラベルに使います。タイトルが無ければ「Notion ページ」と表示します。

誤検出の対策:

- `UTF-8`、`ISO-8601`、`GPT-5`、`SHA-256` などの規格名・モデル名のプレフィックスは除外します(`src/tasks.js` の `DEFAULT_DENY`)。
- ``` で囲まれたコードブロックの中は見ません。
- `main` / `master` / `develop` ブランチは見ません。

### リンク先

- `#123` は、セッションのリポジトリが GitHub なら `owner/repo#123` に解決し、issue へのリンクを付けます。リポジトリが、設定した GitLab のホストにあるときは `group/project#123` に解決し、GitLab の issue へのリンクを付けます(`!123` は MR)。リポジトリは、Claude Code は作業ディレクトリの git remote(origin)、Codex はログの `repository_url` から決めます。PR 番号でも GitHub が転送します。
- `ABC-123` のようなキー形式は、ログに URL があればそれをリンク先にします。無ければ、振り分けたサービスの接続先の設定(Jira の `baseUrl`、Backlog の `space`、Linear の `workspace`)から作ります。それも無ければ `config.json` の `keyUrl` / `urls` を使います。どれも無いとリンクにならず、IDだけを表示します。
- どのサービスの課題かは、「課題管理サービス連携」の「`ABC-123` 形式の振り分け」で決めます。

### 設定

`~/.work-log/config.json`(`WORKLOG_CACHE_DIR` 配下、任意)に書きます。

```json
{
  "tasks": {
    "keys": ["WEB", "API"],
    "deny": ["FOO"],
    "keyUrl": "https://<your-site>.atlassian.net/browse/{id}",
    "urls": { "WEB": "https://<your-site>.atlassian.net/browse/{id}" },
    "github": true
  }
}
```

- `keys`: 指定すると、このプレフィックスのキーだけを拾います。
- `deny`: 除外するプレフィックスを、組み込みの除外に追加します。
- `keyUrl`: キー形式のリンク先です。`{id}` がタスクIDに置き換わります。
- `urls`: プレフィックスごとのリンク先です。`keyUrl` より優先します。
- `github`: `false` にすると、`#123` 系(`owner/repo#123`、`GH-123`、GitHub の URL、番号だけのブランチ名)と、GitLab の `!123`・URL も拾いません。
- `gitlab` / `linear` / `jira` / `backlog` / `notion` / `redmine` / `gitea`: サービスごとの接続先とキーのプレフィックス(Redmine は `projects`・`format`、Gitea は `repos` も)です(「課題管理サービス連携」を参照)。

### 手動の付け外し

詳細パネルの「タスク」欄で操作します。

- ×で外します。
- 入力欄に ID や URL を入れて「紐付け」を押すと付けます。

結果は `links.json` に保存します。外したものは、自動検出で見つかっても表示しません。

### タスクビュー

ヘッダーの「タスク」タブで、期間内に動いたセッションをタスクごとにまとめます。週 / 月の切り替えと、プロジェクト・ツールの絞り込みが効きます。

- 列: タスク、見つけた場所、プロジェクト、セッション数、作業時間、コミット、コスト、期間です。
- ▸で、紐付いたセッションを展開します。クリックすると詳細パネルを開きます。
- 作業時間・コスト・コミットはセッション全体の値です。複数のタスクに紐付くセッションは、それぞれのタスクに数えます。

### 検索

キーワード検索は、タスクIDでも引けます。API では `/api/sessions?task=ID` で絞り込めます(`GET /api/tasks` はタスクごとの集計です)。

### 課題管理サービス連携(GitHub / GitLab / Linear / Jira / Backlog / Notion / Redmine / Gitea)

解決できたタスクについて、各サービスの API から課題の情報を取得して表示します。GitHub と GitLab は設定なしで使えます(トークンが無くても公開リポジトリ・公開プロジェクトなら読めます)。Linear / Jira / Backlog / Notion / Redmine / Gitea(Forgejo)は、接続先や認証情報を設定したときだけ問い合わせます。

共通の動作:

- 取得する内容は、タイトル、状態、ラベル、担当者です。Linear は優先度も取得し、タスクビューに表示します。ラベルは、色があるもの(GitHub / GitLab / Linear)は色付きで表示します。
- 状態は、各サービスの状態名をそのまま表示します(「Open」「In Review」「完了」など)。色は次の4分類で付けます。色だけに頼らず、文字でも示します。

  | 分類 | 色 |
  | --- | --- |
  | 未着手 | 緑 |
  | 進行中 | 青 |
  | 完了 | 紫 |
  | 中止・見送り | 灰 |

- タスクビューでは、タスク欄にサービス名・タイトル・状態・ラベル・担当者を表示します。詳細パネルの「タスク」欄は、状態を表示し、タイトルはホバーで見られます。
- 取れなかったときは、タスクビューにサービス名と理由を表示します(見つからないか権限がない、認証情報が無いか正しくない、読む権限がない、API 制限中、タイムアウト、接続できない)。それ以外の HTTP エラーは、ステータスコードを表示します。
- 結果は `~/.work-log/` にサービスごとのファイル `tracker-<name>.json`(`tracker-gitlab.json`、`tracker-linear.json`、`tracker-jira.json`、`tracker-backlog.json`、`tracker-notion.json`、`tracker-redmine.json`、`tracker-gitea.json`)で保存します。GitHub だけは従来どおり `github.json` です。
- 再確認までの時間は、進行中(未着手を含む)が 10 分、完了・中止が 1 日、取得に失敗したものが 30 分です。
- API 制限に達したら、解除の時刻まで、そのサービスには問い合わせません。
- 画面は取得を最大約 2.5 秒だけ待ちます。それ以上かかる分は裏で取得を続け、取れたら画面を自動更新します。同時に取得するのは 4 件までです(1 回のリクエストは 8 秒でタイムアウトします)。
- 認証情報(トークン、API キー)はサーバー側だけで使い、ブラウザには渡しません。ブラウザに渡すのは、接続先が決まっているか、認証情報があるか、API 制限中かどうかだけです(`GET /api/config` の `trackers`。GitHub は従来の `github` も残しています)。

#### サービスごとの設定

接続先とキーのプレフィックスは、環境変数と `config.json` の `tasks.<サービス名>` のどちらでも設定できます(両方あるときは `config.json` が優先です)。認証情報は環境変数だけです。

| サービス | 環境変数 | config.json(`tasks.<name>`) | 必須 |
| --- | --- | --- | --- |
| GitHub | `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token` | なし(`tasks.github: false` で無効) | 不要(トークン無しは公開リポジトリのみ) |
| GitLab | `GITLAB_TOKEN`、`GITLAB_URL` | `gitlab.baseUrl` | 不要(トークン無しは公開プロジェクトのみ) |
| Linear | `LINEAR_API_KEY` | `linear.keys`、`linear.workspace` | `LINEAR_API_KEY` |
| Jira | `JIRA_BASE_URL`、`JIRA_EMAIL` + `JIRA_API_TOKEN`、`JIRA_PAT` | `jira.baseUrl`、`jira.keys` | 接続先と認証情報 |
| Backlog | `BACKLOG_SPACE`、`BACKLOG_API_KEY` | `backlog.space`、`backlog.keys` | スペースと `BACKLOG_API_KEY` |
| Notion | `NOTION_TOKEN` / `NOTION_API_KEY`、`NOTION_DATABASE_ID` / `NOTION_DATA_SOURCE_ID` | `notion.databaseId` / `notion.dataSourceId`、`notion.keys`、`notion.idProperty` | トークン(ページ URL のみ扱うなら)。キー形式も扱うならデータベースの指定も |
| Redmine | `REDMINE_URL`、`REDMINE_API_KEY` | `redmine.baseUrl`、`redmine.format`、`redmine.projects`、`redmine.keys` | 接続先と `REDMINE_API_KEY` |
| Gitea / Forgejo | `GITEA_URL`、`GITEA_TOKEN`(`FORGEJO_URL` / `FORGEJO_TOKEN` も可) | `gitea.baseUrl`、`gitea.repos` | 接続先とトークン |

```json
{
  "tasks": {
    "gitlab": { "baseUrl": "https://gitlab.example.com" },
    "linear": { "keys": ["<PREFIX>"], "workspace": "<workspace>" },
    "jira": { "baseUrl": "https://<your-site>.atlassian.net", "keys": ["<PREFIX>"] },
    "backlog": { "space": "<space>.backlog.jp", "keys": ["<PREFIX>"] },
    "notion": { "databaseId": "<32桁のデータベースID>", "keys": ["<PREFIX>"], "idProperty": "<IDプロパティ名>" },
    "redmine": { "baseUrl": "https://redmine.example.com", "format": "markdown", "projects": ["<Work Log のプロジェクト名>"], "keys": ["RM"] },
    "gitea": { "baseUrl": "https://git.example.com", "repos": ["owner/repo"] }
  }
}
```

認証情報(トークン、API キー)は `config.json` に書かず、環境変数で渡します。

#### `ABC-123` 形式の振り分け

`ABC-123` のようなキー形式は、Linear・Jira・Backlog・Notion のどれの課題か分からないので、次の順で決めます。Redmine の `#123` と Gitea の `owner/repo#12` は GitHub と同じ形なので、別の規則で振り分けます(「Redmine」「Gitea / Forgejo」を参照)。

1. ログ中の URL のホスト: `linear.app` は Linear、`notion.so` / `www.notion.so` / `*.notion.site` は Notion、`*.backlog.jp` / `*.backlog.com`(`backlogtool` のドメインも)は Backlog、`/browse/` を含み `*.atlassian.net` か設定した Jira のホストなら Jira です。
2. `tasks.<サービス>.keys` のプレフィックス(Linear、Jira、Backlog、Notion の順に調べます)。
3. 設定済みのキー形式のサービスが 1 つだけならそのサービス。「設定済み」は、Linear は `LINEAR_API_KEY` があるとき、Jira は接続先 URL があるとき、Backlog はスペースがあるとき、Notion はトークンとデータベース(またはデータソース)の指定があるときです。
4. 決まらなければ、リンクのみにします(従来の `keyUrl` / `urls`)。情報は取得しません。

#### GitHub

`owner/repo#123` に解決できたタスクが対象です。

- 状態は、Issue が Open / Closed、PR が Open / Draft / Merged / Closed です。分類は、Draft の PR が進行中、Merged と完了で閉じた issue が完了、マージせずに閉じた PR と `not_planned` で閉じた issue が中止・見送りです。
- トークンは `GITHUB_TOKEN`、`GH_TOKEN`、`gh auth token`(GitHub CLI)の順に探します。`WORKLOG_GITHUB_NO_GH=1` を設定すると、`gh` は呼びません。
- どれも無ければ未認証です。公開リポジトリだけ読め、API の上限は小さくなります。
- 再確認は ETag の条件付きリクエストで行います。304 は API の制限を消費しません。
- `WORKLOG_GITHUB_API` で API の URL を変えられます(GitHub Enterprise Server の API など)。ただし、`#123` からリポジトリを決める処理は github.com のリモートだけに対応しています。GitHub Enterprise Server の issue をこの連携で扱うには、`owner/repo#123` と書く必要があります(リンク先 URL も github.com になります)。
- リポジトリ名は GitHub の命名規則で検証してから、API の URL に使います。合わない名前は問い合わせません。
- ラベルの色は 6 桁の 16 進数のものだけを使います。それ以外は色を付けません(GitLab / Linear のラベルも同じです)。

#### GitLab

issue(`#123`)と マージリクエスト(`!123`)が対象です。

- 接続先は `tasks.gitlab.baseUrl`、無ければ `GITLAB_URL`、既定は `https://gitlab.com` です。トークンは `GITLAB_TOKEN` を `PRIVATE-TOKEN` ヘッダーで送ります。トークン無しでも公開プロジェクトは読めます。
- `#123` と `!123` は、リポジトリのリモートが設定した GitLab のホストのときだけ API に問い合わせます。それ以外の GitLab らしいホスト(ホスト名に `gitlab.` を含むもの)は、リンクだけです。URL で書かれた issue / MR も、ホストが設定と一致したときだけ取得します。
- サブグループ(`group/subgroup/project`)に対応します。プロジェクトのパスは `%2F` でエンコードして API に渡します。
- 状態は、issue が Open / Closed(閉じたら完了)、MR が Open / Merged / Closed / Locked です。分類は、Draft の MR が進行中、Merged が完了、Closed と Locked が中止・見送りです。GitLab には完了と見送りの区別が無いので、閉じた issue は完了とみなします。
- 再確認は GitHub と同じく ETag の条件付きリクエストです。

#### Linear

- `LINEAR_API_KEY` に個人 API キーを設定します。Bearer を付けずに `Authorization` ヘッダーでそのまま送ります(`lin_oauth` で始まる OAuth トークンだけ Bearer を付けます)。キーが無ければ問い合わせません。
- 識別子(`ABC-123`)のまま GraphQL API の `issue(id:)` に渡して取得します。
- 状態は Linear のワークフローの状態名を表示します。分類は、triage / backlog / unstarted が未着手、started が進行中、completed が完了、canceled / duplicate が中止・見送りです。
- `tasks.linear.keys` はキーのプレフィックスです。`tasks.linear.workspace` を設定すると、取得する前から `https://linear.app/<workspace>/issue/<ID>` のリンクを付けます。取得後は、Linear が返す URL を使います。

#### Jira

- 接続先は `tasks.jira.baseUrl` か `JIRA_BASE_URL` で、必須です。
- Jira Cloud は `JIRA_EMAIL` + `JIRA_API_TOKEN`(Basic 認証)、Server / Data Center は `JIRA_PAT`(Bearer)です。両方あれば Basic が先です。
- REST API v2(`/rest/api/2/issue/<キー>`)を使います。
- 状態は Jira の状態名を表示します。分類は、状態のカテゴリが new なら未着手、indeterminate なら進行中、done なら完了です。Jira には中止・見送りのカテゴリが無いので、この分類にはなりません。
- `tasks.jira.keys` はキーのプレフィックスです。リンク先は `<baseUrl>/browse/<ID>` です。

#### Backlog

- スペースは `tasks.backlog.space` か `BACKLOG_SPACE` で設定します(例: `<space>.backlog.jp`。`https://` は付けても外します)。`.backlog.jp` / `.backlog.com`(`backlogtool` のドメインも)のホストだけ受け付け、それ以外は無効です。
- API キーは `BACKLOG_API_KEY` です。URL ではなく `Backlog-API-Key` ヘッダーで送ります(URL に載せないので、ログやプロキシに残りにくくなります)。キーが無ければ問い合わせません。
- 状態は Backlog の状態名を表示します。分類は、標準の状態で 未対応が未着手、処理中・処理済みが進行中、完了が完了です。プロジェクトで追加した状態は進行中とみなします。ラベルには、課題のカテゴリを表示します。
- `tasks.backlog.keys` はプロジェクトキーのプレフィックスです。リンク先は `https://<スペース>/view/<ID>` です。

#### Notion

- トークンは `NOTION_TOKEN`(無ければ `NOTION_API_KEY`)のインテグレーションのシークレットで、`Authorization: Bearer` で送ります。無ければ問い合わせません。API のバージョン(`Notion-Version`)は `2025-09-03` です。
- ページ URL のタスクは、ページ ID でそのまま取得します。ページは、そのインテグレーションに共有しておく必要があります。
- `TASK-12` のようなキー形式は、Notion データベースの ID プロパティ(`unique_id`)の値として扱います。`tasks.notion.databaseId`(または `dataSourceId`。環境変数 `NOTION_DATABASE_ID` / `NOTION_DATA_SOURCE_ID` でも可)の指定が必要で、データベースもインテグレーションに共有しておきます。データベースだけを指定したときは、最初のデータソースで探します。ID プロパティは、`tasks.notion.idProperty` で名前を指定できます。省略すると、接頭辞が一致する `unique_id` プロパティを自動で探します。
- 取得する内容は次のとおりです。
  - タイトル: `title` プロパティです。
  - 状態: `status` プロパティです。無ければ、値のある `select` を使います。
  - タグ: 最初の `multi_select` です。Notion の色名(gray / brown / orange など)を色に変換します。
  - 担当者: 最初の `people` です。
  - 種類の欄: ID プロパティがあれば `TASK-12` のように表示し、無ければ「Page」と表示します。
- 状態の分類は、データソースの `status` のグループで決めます。既定の To-do が未着手、In progress が進行中、Complete が完了です。状態名に「中止」「見送り」「cancel」などを含むときは、中止・見送りとします。データソースの定義は 1 時間使い回します。
- `tasks.notion.keys` はキーのプレフィックスです。リンク先は、取得したページの URL です。

#### Redmine

- 接続先は `tasks.redmine.baseUrl` か `REDMINE_URL`、鍵は `REDMINE_API_KEY`(`X-Redmine-API-Key` ヘッダー)です。取得するのは、タイトル、状態(`status.is_closed` で完了を判定)、トラッカー、担当者、優先度です。
- `#123` は、次の順で Redmine の課題と決めます。(1) URL が `REDMINE_URL` の下の課題の URL、(2) `tasks.redmine.projects`(Work Log のプロジェクト名の配列。そのプロジェクトの `#123` を Redmine とみなす。`"*"` ですべて)、`tasks.redmine.keys`(`RM-123` を `#123` とみなす)、(3) セッションのリポジトリが無いときは、Redmine を設定していれば Redmine。
- 作業記録のコメントは、課題の注記(`PUT /issues/{id}.json`)として投稿します。書式は API から分からないため、`tasks.redmine.format` で `markdown`(既定)か `textile` を指定します。Textile では表の記号などを `<notextile>` で囲んで逃がします。
- 公開プロジェクトは鍵が間違っていても匿名で読めるため、鍵の誤りは投稿のときに初めて分かります。

#### Gitea / Forgejo

- 接続先は `tasks.gitea.baseUrl` か `GITEA_URL`(`FORGEJO_URL` も可)、トークンは `GITEA_TOKEN`(`FORGEJO_TOKEN` も可。`Authorization: token` で送ります)です。2 つは同じ API(`/api/v1`)なので同じ実装で扱います。取得するのは、タイトル、状態、ラベル、担当者で、プルリクエストも扱います。
- `owner/repo#12` は、URL が `GITEA_URL` の下の issue の URL、`tasks.gitea.repos`(`"owner/repo"` の配列)に載っているリポジトリ、セッションのリポジトリのホストが Gitea のホスト、の順で Gitea のものと決めます。
- 作業記録のコメントは、issue のコメント(`POST …/issues/{n}/comments`)で、書式は Markdown です。

#### 作業記録のコメント

課題に、そのタスクの作業記録をコメントとして投稿できます。対象は GitHub に限らず、GitLab・Linear・Jira・Backlog・Notion・Redmine・Gitea の課題です。

1. タスクビューでタスクを▸で展開し、「<サービス> の <ID> に作業記録をコメント…」を押します。ボタンは、課題の情報が取得できたタスクにだけ出ます(まだ取得できていない課題や、見つからない課題には出ません)。
2. 確認ダイアログに、投稿される本文がそのまま表示されます。本文は、セッションの開始時刻・タイトル・ツール・作業時間・コミット数(とハッシュ)と、合計です。時刻はブラウザのタイムゾーンで書きます。
3. 「投稿する」を押したときだけ投稿します。「やめる」では何も送りません。

本文の書式は、サービスに合わせて書き分けます(Redmine は設定で Markdown と Textile を選びます)。Notion は、Backlog と同じプレーンテキストです。

| サービス | 書式 |
| --- | --- |
| GitHub / GitLab / Linear / Gitea | Markdown の表 |
| Redmine | `tasks.redmine.format` に従い、Markdown の表か Textile の表(既定は Markdown) |
| Jira | Wiki 記法の表。`\|`、`{`、`}`、`[`、`]` は記法として解釈されるため、全角にします |
| Backlog / Notion | 箇条書きのプレーンテキスト。Backlog は、プロジェクトの記法が Backlog 記法でも Markdown でも崩れないよう、表を使いません |

Notion には `POST /v1/comments` で、ページへのコメントとして投稿します。本文は `rich_text` を 2000 文字ずつに分けて送ります。キー形式のタスクは、ID プロパティで探したページに投稿します。コメントを投稿できるかは、Notion 側のインテグレーションの権限設定によります。リンクは、ページの URL です。

- 本文は秘匿情報をマスキングします(`WORKLOG_NO_MASK=1` の対象外です)。
- プレビューの後にセッションが進むなどして内容が変わったときは、投稿せずに、もう一度確認するよう求めます。
- 投稿には認証情報が必要です(課題にコメントできる権限)。無いときは、ダイアログを出さずにそう表示します。
- 投稿後は、投稿したコメントへのリンクを表示します。画面の自動更新で描き直しても残ります(ページを再読み込みすると消えます)。
- コメントは、その課題を見られる人全員が読めます。公開リポジトリや公開プロジェクトなら誰でも読めるので、内容を確認してから投稿してください。

#### 動作確認

- GitLab: 実際の公開 API で、issue、MR、見つからないもの、ETag の再確認(304)まで確認しました。コメントの投稿は、実際の API では確認していません。
- GitHub: 応答形式はテストの偽サーバーで確認しています。実際の API には、「見つからない」の応答まで接続して確認しました。実在する issue の取得とコメントの投稿は、実際の API では確認していません。
- Linear / Jira / Backlog: この開発環境から接続できないため、実際のサービスでは確認していません。公式の SDK / ドキュメント(`@linear/sdk` の型定義、gitlabhq の `doc/api`、nulab/backlog-js、jira.js)に合わせた偽サーバーとテストでだけ確認しています。実際に使うときは、まず取得の表示から確かめてください。
- Redmine(Docker の `redmine:6` = 6.1.5): 実際のサーバーで確認しました。課題の取得(状態・トラッカー・担当者・優先度)、`X-Redmine-API-Key` での認証、注記の投稿(204 で本文なし。`?include=journals` で注記の ID が分かり、課題の画面に `id="change-{id}"` が出る)、新しく入れた Redmine の既定の書式が Markdown(`common_mark`)であること、書式を Textile にしたサーバーで作業記録が表として表示されることです。確認で見つけた不具合は、Textile の記号の逃がし方(`<notextile>` で囲むようにしました)です。未確認: Redmine 5.x 以前(`status.is_closed` が無い版は状態の名前から推測します)、非公開プロジェクトでの 401 / 403 の応答。
- Gitea(Docker の `gitea/gitea:latest` = 28.0.0): 実際のサーバーで確認しました。issue の取得(タイトル・状態・ラベル・担当者・プルリクエストの区別)、`Authorization: token`、コメントの投稿(コメントへのリンクが返る)、閉じた issue、存在しない issue(404)、誤ったトークン(401)です。未確認: Forgejo(この環境から codeberg.org のレジストリに届かず、Docker Hub は利用制限で取得できませんでした。API は Gitea から分かれたもので同じ形のはずです)、プルリクエストのマージ済み・下書きの状態、ETag。
- Notion: Notion の API にもこの開発環境から接続できないため、実際のサービスでは確認していません。公式 SDK(`@notionhq/client`、`Notion-Version` 2025-09-03)の型定義に合わせた偽サーバーとテスト(`test/notion.test.js`)でだけ確認しています。取得もコメントの投稿も、実際に使うときはまず取得の表示から確かめてください。

## 送り先連携

日報・週報を、チャット(Slack、Discord、Microsoft Teams、Google Chat、Chatwork、Mattermost、Rocket.Chat、LINE WORKS、Matrix)、メール(SMTP)、汎用 Webhook、ドキュメント(Confluence、esa、Qiita Team、Obsidian)に送ります。画面からも CLI からも送れます。送り先は `src/destinations.js` の一覧にあり、1 項目足せば増やせます。セッション終了の通知(任意)もあります。送り先は 1 つでも複数でも設定でき、設定が無ければ何も送りません。

### 共通の動作

- 日報・週報の内容、期間、タイムゾーンの扱いは、どちらの送り先でも同じです(「日報・週報の内容」)。
- 画面からは、確認ダイアログで送る内容を見てから送ります。プレビューの後に内容が変わったときは、送らずに、もう一度確認するよう求めます。
- CLI の `report` は、送り先のオプション(`--slack` / `--discord` / `--teams` / `--google-chat` / `--chatwork` / `--mattermost` / `--rocketchat` / `--lineworks` / `--matrix` / `--email` / `--webhook` / `--confluence` / `--esa` / `--qiita-team` / `--obsidian`)を付けると確認なしで送ります。
- セッション終了の通知は、送り先ごとに `notify` を設定します。送ったものは二度送りません。
- 本文は、書式を整える前に秘匿情報をマスキングします(「秘匿情報」)。
- Webhook の URL とトークンはサーバー側だけで使い、ブラウザには渡しません。

送り先ごとの違いは次のとおりです。

| | Slack | Discord | Teams | Google Chat |
| --- | --- | --- | --- | --- |
| 送り方 | Incoming Webhook か Bot トークン | Webhook | Workflows の Webhook か Incoming Webhook(廃止予定) | スペースの Webhook |
| 環境変数 | `SLACK_WEBHOOK_URL`、`SLACK_BOT_TOKEN`、`SLACK_CHANNEL` | `DISCORD_WEBHOOK_URL` | `TEAMS_WEBHOOK_URL` | `GOOGLE_CHAT_WEBHOOK_URL` |
| 書式 | blocks(mrkdwn) | embeds(Markdown) | Adaptive Card | テキスト(`*太字*`、`<URL|名前>`) |
| 投稿へのリンク | Bot のときだけ | メッセージへのリンクが取れたとき | なし | なし |
| `config.json` | `slack` | `discord` | `teams` | `googlechat` |

あとから加えた送り先は次のとおりです。

| | 送り方 | 環境変数 | `config.json` | 投稿へのリンク | セッション終了の通知 |
| --- | --- | --- | --- | --- | --- |
| Chatwork | API(ルームへ投稿) | `CHATWORK_API_TOKEN`、`CHATWORK_ROOM_ID` | `chatwork` | あり | あり |
| Mattermost | Incoming Webhook | `MATTERMOST_WEBHOOK_URL` | `mattermost` | なし | あり |
| Rocket.Chat | Incoming Webhook | `ROCKETCHAT_WEBHOOK_URL` | `rocketchat` | なし | あり |
| LINE WORKS | Bot API 2.0 | `LINEWORKS_*`(後述) | `lineworks` | なし | あり |
| Matrix | Client-Server API(ルームへ投稿) | `MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`、`MATRIX_ROOM_ID` | `matrix` | あり(`matrix.to` のリンク) | あり |
| メール | SMTP(依存なしの自前のクライアント) | `SMTP_URL`、`MAIL_FROM`、`MAIL_TO` | `email` | なし | あり |
| 汎用 Webhook | JSON を POST | `WORKLOG_WEBHOOK_URL`、`WORKLOG_WEBHOOK_SECRET` | `webhook` | なし | あり |
| Confluence | ページを作る・更新する | `CONFLUENCE_*` | `confluence` | あり | なし |
| esa | 記事を作る・更新する | `ESA_ACCESS_TOKEN`、`ESA_TEAM` | `esa` | あり | なし |
| Qiita Team | 記事を作る・更新する | `QIITA_ACCESS_TOKEN`、`QIITA_TEAM_DOMAIN` | `qiitateam` | あり | なし |
| Obsidian | Vault にノートを書く | `OBSIDIAN_VAULT_DIR` | `obsidian` | あり(`obsidian://` の URI) | あり |

どの送り先にも、`config.json` の `includeCost`(API 換算コストを載せるか)と `maxSessions`(セッション一覧の件数。ページ形式は既定 500、ほかは 20)を使えます。通知のある送り先は `notify` も使えます。
### Slack

#### 送り方

どちらか一方を環境変数で設定します。

- Incoming Webhook: `SLACK_WEBHOOK_URL`。`https://` の URL だけ使います。
- Bot トークン: `SLACK_BOT_TOKEN` と、送り先のチャンネル(`config.json` の `slack.channel`、無ければ `SLACK_CHANNEL`)。Slack アプリの設定で、そのチャンネルに投稿できるようにしておいてください。投稿には `chat.postMessage` を、投稿へのリンクの取得には `chat.getPermalink` を使います。リンクが取れなくても投稿は成功扱いです。

両方あるときは、投稿のリンクが取れる Bot を優先します。Webhook にはリンクを返す仕組みが無いので、「開く」リンクは出ません。リダイレクトは追わず、1 回のリクエストは 10 秒でタイムアウトします。Bot の API が 429 を返したときは、再試行までの秒数を表示します。`WORKLOG_SLACK_API` は API の URL を変えるためのもので、主にテスト用です。

画面に渡すのは、送り先の種類(Bot / Webhook)とチャンネル名(Webhook のときは「Incoming Webhook」)、コストを含めるか、通知の設定だけです(`GET /api/config` の `slack`)。

#### 設定

`~/.work-log/config.json` の `slack` に書きます(任意)。

```json
{
  "slack": {
    "channel": "<チャンネル名または ID>",
    "includeCost": false,
    "maxSessions": 20,
    "notify": "session_end"
  }
}
```

- `channel`: Bot で投稿するチャンネルです。
- `includeCost`: `true` にすると、合計に API 換算コストを載せます。既定は載せません。
- `maxSessions`: セッション一覧に出す件数です。既定は 20 で、超えた分は「ほか n セッション」とまとめます。
- `notify`: `"session_end"` にすると、セッション終了を通知します(後述)。

トークンや Webhook の URL は `config.json` に書かず、環境変数で渡します。

#### 送る本文

- Slack の記法で意味を持つ `&` `<` `>` は、逃がしてから送ります。
- 1 セクションが 3000 文字を超えないよう、セッション一覧は分けて送ります。

### Discord

#### 送り方

`DISCORD_WEBHOOK_URL` に Webhook の URL を設定します。

- 受け付けるのは、Discord の Webhook の URL(`https://discord.com/api/webhooks/…` など)だけです。`discordapp.com`、`ptb.` / `canary.` のホスト、`/api/v10/` のようなバージョン付きの形も使えます。`http://` や、Discord 以外のホストの URL は使いません。
- `WORKLOG_DISCORD_WEBHOOK_ANY=1` を設定すると、Discord 以外の URL も許します。偽サーバーを使うテスト用です。
- `?wait=true` を付けて送ります。返ってきたメッセージの情報からサーバーのメッセージへのリンクが作れれば、画面に「開く」を出します(`guild_id` が返らないとリンクは出ません。リンクが取れなくても送信は成功扱いです)。
- リダイレクトは追わず、1 回のリクエストは 10 秒でタイムアウトします。429 が返ったときは、再試行までの秒数を表示します。

画面に渡すのは、送り先が使えるか、送り先の表示名(「Discord Webhook」)、コストを含めるか、通知の設定だけです(`GET /api/config` の `discord`)。

#### 設定

`~/.work-log/config.json` の `discord` に書きます(任意)。

```json
{
  "discord": {
    "includeCost": false,
    "maxSessions": 20,
    "notify": "session_end",
    "username": "Work Log"
  }
}
```

- `includeCost`: `true` にすると、合計に API 換算コストを載せます。既定は載せません。
- `maxSessions`: セッション一覧に出す件数です。既定は 20 で、超えた分は「ほか n セッション」とまとめます。
- `notify`: `"session_end"` にすると、セッション終了を通知します(後述)。
- `username`: 投稿の送信者名です。既定は `Work Log` です。

#### 送る本文

- embeds で送ります。見出し(期間と合計)、プロジェクト別、タスク、セッションを、それぞれ 1 つの embed にします。
- embed の説明は 4096 文字、メッセージ全体は 6000 文字、embed は 10 個までに収めます。収まらない行は「…ほか n 行」とまとめます。
- Markdown で意味を持つ記号は逃がします。タスクは、リンクがあれば Markdown のリンクにします。
- `allowed_mentions` を空にして送ります。本文に `@everyone` などが入っていても、通知は飛びません。

### Teams

#### 送り方

`TEAMS_WEBHOOK_URL` に Webhook の URL を設定します。

- Workflows(Power Automate)の「Webhook 要求を受信したらチャネルに投稿する」テンプレートで作ったフローの URL(`*.logic.azure.com` / `*.powerplatform.com`)を使います。従来の Incoming Webhook の URL(`*.webhook.office.com`)も使えますが、Microsoft が廃止を予定しています。`http://` や、これら以外のホストの URL は使いません。
- `WORKLOG_TEAMS_WEBHOOK_ANY=1` を設定すると、これら以外の URL も許します。偽サーバーを使うテスト用です。
- Teams は投稿したメッセージへのリンクを返さないので、画面に「開く」は出ません。
- リダイレクトは追わず、1 回のリクエストは 10 秒でタイムアウトします。429 が返ったときは、再試行までの秒数を表示します。

画面に渡すのは、送り先が使えるか、送り先の表示名(「Workflows」または「Incoming Webhook」)、コストを含めるか、通知の設定だけです(`GET /api/config` の `teams`)。Webhook の URL はブラウザには渡しません。

#### 設定

`~/.work-log/config.json` の `teams` に書きます(任意)。

```json
{
  "teams": {
    "includeCost": false,
    "maxSessions": 20,
    "notify": "session_end"
  }
}
```

- `includeCost`: `true` にすると、合計に API 換算コストを載せます。既定は載せません。
- `maxSessions`: セッション一覧に出す件数です。既定は 20 で、超えた分は「ほか n セッション」とまとめます。
- `notify`: `"session_end"` にすると、セッション終了を通知します(後述)。

#### 送る本文

- Adaptive Card(バージョン 1.4、幅は全幅)を、`{ "type": "message", "attachments": [...] }` に包んで送ります。見出し(期間と合計)、プロジェクト別、タスク、セッションの順に並べます。
- TextBlock の Markdown は、太字・リスト・リンクしか使えません。意味を持つ `*` `_` `[` `]` は、タイトルなどの中では全角(`＊` `＿` `［` `］`)に置き換えます。
- メッセージ全体が 28KB の制限に収まるよう、セッション一覧を後ろから減らし、減らした分は「ほか n セッション」とまとめます。

### Google Chat

#### 送り方

`GOOGLE_CHAT_WEBHOOK_URL` に Webhook の URL を設定します。

- スペースの「アプリと統合」→「Webhook を管理」で作った Webhook の URL(`https://chat.googleapis.com/v1/spaces/{space}/messages?key=...&token=...`)だけを使います。`http://` や、これ以外の URL は使いません。
- `WORKLOG_GOOGLE_CHAT_WEBHOOK_ANY=1` を設定すると、これ以外の URL も許します。偽サーバーを使うテスト用です。
- URL の `key` と `token` は認証情報です。サーバー側だけで使い、ブラウザには渡しません。
- Webhook の応答には `name` と `thread.name` しか入らず、投稿へのリンクは返らないので、画面に「開く」は出ません。
- リダイレクトは追わず、1 回のリクエストは 10 秒でタイムアウトします。429 が返ったときは、再試行までの秒数を表示します。API のエラーは、`error.message` を表示します。

画面に渡すのは、送り先が使えるか、送り先の表示名(「Webhook」)、コストを含めるか、通知の設定だけです(`GET /api/config` の `googlechat`)。Webhook の URL はブラウザには渡しません。

#### 設定

`~/.work-log/config.json` の `googlechat` に書きます(任意)。

```json
{
  "googlechat": {
    "includeCost": false,
    "maxSessions": 20,
    "notify": "session_end"
  }
}
```

- `includeCost`: `true` にすると、合計に API 換算コストを載せます。既定は載せません。
- `maxSessions`: セッション一覧に出す件数です。既定は 20 で、超えた分は「ほか n セッション」とまとめます。
- `notify`: `"session_end"` にすると、セッション終了を通知します(後述)。

#### 送る本文

- テキストメッセージ(`{ "text": ... }`)で送ります。見出し(期間と合計)、プロジェクト別、タスク、セッションの順に並べます。
- 書式は、`*太字*` の見出し、`• ` のリスト、`<URL|名前>` のリンクです。
- Chat には記号を逃がす書き方がないので、タイトルなどの中の `*` `_` `~` `` ` `` `<` `>` `|` は全角に置き換えます。`<users/all>` のようなメンションとして解釈されるのも、これで防ぎます。
- メッセージ全体は 32,000 バイトまでです(Chat API の Message の説明)。収まるよう、セッション一覧を後ろから減らし、減らした分は「ほか n セッション」とまとめます。

### Chatwork

`CHATWORK_API_TOKEN` と、送り先のルーム ID(`config.json` の `chatwork.roomId`、無ければ `CHATWORK_ROOM_ID`)を設定します。

- `POST https://api.chatwork.com/v2/rooms/{room_id}/messages` に、`body` を `application/x-www-form-urlencoded` で送ります。トークンは `X-ChatWorkToken` ヘッダーです。
- 応答の `message_id` から、投稿へのリンク(`https://www.chatwork.com/#!rid{room}-{message_id}`)を作って、画面に「開く」を出します。
- 本文は 1 通 65535 文字までですが、Work Log は 30000 文字に収めます。収まらないセッションは「ほか n セッション」とまとめます。
- Chatwork の記法(`[To:…]`、`[info]` など)は `[` で始まるので、タイトルなどの中の `[` `]` は全角にして、記法として働かないようにします。
- トークンはサーバー側だけで使い、ブラウザには渡しません。

`config.json` の `chatwork` に書きます(任意)。

```json
{
  "chatwork": { "roomId": "<ルーム ID>", "includeCost": false, "maxSessions": 20, "notify": "session_end" }
}
```

### Mattermost

`MATTERMOST_WEBHOOK_URL` に、チャンネルの Incoming Webhook の URL(`https://<host>/hooks/<ID>`)を設定します。自分のサーバーで動かすものなので、`https://` であればホストは問いません(サブパスで動かしているサーバーも使えます)。

- `{ "text", "username", "icon_url" }` を JSON で POST します。投稿へのリンクは返らないので、「開く」は出ません。
- 本文は 16383 文字に収めます(古いサーバーの上限に合わせています)。収まらないセッションは「ほか n セッション」とまとめます。
- Markdown の記号は `\` で逃がし、`@channel` / `@all` / `@here` / `@ユーザー名` は全角の `＠` にして、メンションにしません。
- Webhook の URL は認証情報なので、サーバー側だけで使います。

`config.json` の `mattermost` に書きます(任意)。`username` と `iconUrl` は、投稿の表示名とアイコンです。Mattermost は、サーバー設定 `EnablePostUsernameOverride` が有効でないと `username` を無視します(既定は無効)。表示名を変えたいときは、管理者に有効にしてもらってください。

```json
{
  "mattermost": { "username": "Work Log", "iconUrl": "https://example.com/icon.png", "includeCost": false, "maxSessions": 20, "notify": "session_end" }
}
```

### Rocket.Chat

`ROCKETCHAT_WEBHOOK_URL` に、管理画面の「インテグレーション」で作った Incoming Webhook の URL(`https://<host>/hooks/<ID>/<token>`)を設定します。`https://` であればホストは問いません。Incoming インテグレーションを作るユーザーには、メッセージの成りすまし(message-impersonate)権限が必要です(例: `rocket.cat`)。

- `{ "text" }` を JSON で POST します。投稿へのリンクは返らないので、「開く」は出ません。失敗は `success: false` と `error` の JSON で返るので、その `error` を表示します。
- 本文は、既定の上限(`Message_MaxAllowedSize` の初期値 5000)に収めます。
- Markdown の記号の確かな逃がし方が見つからなかったので、タイトルなどの中の記号は全角に置き換えます。
- URL(`token` を含む)は認証情報なので、サーバー側だけで使います。

`config.json` の `rocketchat` に書きます(任意)。

```json
{
  "rocketchat": { "includeCost": false, "maxSessions": 20, "notify": "session_end" }
}
```

### LINE WORKS

Bot API 2.0 で、トークルームに送ります。サービスアカウントの JWT(RS256)を秘密鍵で署名し、`https://auth.worksmobile.com/oauth2/v2.0/token` でアクセストークン(scope `bot`)に換え、期限まで使い回します。送信は `POST https://www.worksapis.com/v1.0/bots/{botId}/channels/{channelId}/messages` です。

環境変数:

- `LINEWORKS_CLIENT_ID` / `LINEWORKS_CLIENT_SECRET` / `LINEWORKS_SERVICE_ACCOUNT`
- `LINEWORKS_PRIVATE_KEY`(PEM。改行は `\n` でもよい)か `LINEWORKS_PRIVATE_KEY_FILE`(ファイルのパス)
- `LINEWORKS_BOT_ID`
- `LINEWORKS_CHANNEL_ID`(`config.json` の `lineworks.channelId` でもよい)
- `WORKLOG_LINEWORKS_AUTH`(トークンの URL)、`WORKLOG_LINEWORKS_API`(API の基点): 主にテスト用です。

- テキストは 1 通 2000 文字までなので、1900 文字ごとに分け、最大 5 通で送ります。5 通に収まらないセッションは「ほか n セッション」とまとめます。
- 秘密鍵・Client Secret・トークンはサーバー側だけで使い、ブラウザには渡しません。

```json
{
  "lineworks": { "channelId": "<チャンネル ID>", "includeCost": false, "maxSessions": 20, "notify": "session_end" }
}
```

### メール(SMTP)

- 環境変数は `SMTP_URL`(`smtp://user:pass@host:587` は STARTTLS、`smtps://user:pass@host:465` は最初から TLS。ユーザー名とパスワードは URL エンコード)、`MAIL_FROM`、`MAIL_TO`(カンマ区切りで複数)です。`config.json` の `email.from` / `email.to`(文字列か配列)/ `email.subjectPrefix` でも設定でき、そちらを優先します。`WORKLOG_SMTP_SECURE=1` は `smtp://` でも最初から TLS(465 番は常にそう)、`WORKLOG_SMTP_INSECURE=1` は証明書を確かめません(手元のテスト用)。自己署名の CA は `NODE_EXTRA_CA_CERTS` で足せます。
- 流れは、接続、EHLO(だめなら HELO)、STARTTLS(提示されていれば必ず使う)、AUTH PLAIN / LOGIN(認証情報があるとき)、MAIL FROM、RCPT TO(1 つでも宛先が断られたら送らない)、DATA です。
- 認証情報があるのに TLS にならないときは、手元(`localhost` / `127.0.0.0/8` / `::1`)のサーバー以外には送りません(パスワードを平文で流さないため)。
- 本文は text と HTML の両方で、常に base64 で送ります。件名は RFC 2047 で符号化し、CR / LF を含む値はヘッダーに入れません。From / To / Date / Message-ID は、送るときに足します(本文と同じ文字列に秘匿情報のマスキングをかけると、アドレスが `[EMAIL]` になってしまうため)。
- URL のパスワードはサーバー側だけで使い、状態にはホストとポートだけを返します。
- `email.notify` を `"session_end"` にすると、セッション終了の通知もメールで送ります(`subjectPrefix` が付きます)。

### Matrix

- 環境変数は `MATRIX_HOMESERVER`(`https` の URL。`http` は `localhost` / `127.0.0.1` / `::1` だけ)、`MATRIX_ACCESS_TOKEN`、`MATRIX_ROOM_ID`(`!` で始まるルーム ID。`#別名` は使えない。`matrix.roomId` でも可)です。`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}` で投稿します。
- `msgtype` は既定で `m.notice` です。自動の投稿向けの種類で、既定のプッシュ規則(`.m.rule.suppress_notices`)により、通知も未読の数も増えません。普通の発言と同じく未読に数えたいときは `matrix.msgtype` を `"m.text"` にします(それでもメンションにはなりません)。
- `"m.mentions": {}` を付けて「誰にもメンションしない」と宣言します。本文に `@room` や表示名があっても、古い規則(`.m.rule.roomnotif` など)によるハイライトが起きません。古いクライアント向けに、本文の `@` も全角にします。
- 429(`M_LIMIT_EXCEEDED`)のときは、待ってから同じ `txnId` で送り直します(サーバーが同じ送信として扱うので二重に投稿されません)。
- 暗号化はしないので、暗号化したルームには送らないでください。アクセストークンはサーバー側だけで使います。

### 汎用 Webhook

Zapier、n8n、Make などに、日報・週報とセッション終了の通知を JSON で POST します。そこから先の転送先は、Work Log では分かりません。

- `WORKLOG_WEBHOOK_URL`: `https://` の URL か、手元の受け口(`localhost` / `127.0.0.1` / `::1`)の `http://` だけ使います。リダイレクトは追わず、1 回のリクエストは 10 秒でタイムアウトします。429 のときは再試行までの秒数を表示します。投稿へのリンクは返りません。
- `WORKLOG_WEBHOOK_SECRET`(任意): 設定すると、次の 2 つのヘッダーを付けます。
  - `X-WorkLog-Timestamp`: 送った時刻(UNIX 秒)
  - `X-WorkLog-Signature`: `sha256=<hex>`。`"<時刻>.<本文>"` の HMAC-SHA256 で、本文は送るバイト列そのままです。
- URL と鍵はサーバー側だけで使い、ブラウザには渡しません(画面に渡すのは URL のホストだけです)。
- `config.json` の `webhook` は `includeCost`、`maxSessions`、`notify`。

日報・週報(`type: "report"`)の JSON:

```json
{
  "type": "report",
  "version": 1,
  "period": "day",
  "range": { "start": "2026-10-03T15:00:00.000Z", "end": "2026-10-04T15:00:00.000Z", "startDate": "2026-10-04", "timeZone": "Asia/Tokyo" },
  "totals": { "activeMs": 5400000, "sessions": 3, "commits": 2, "usd": 1.23 },
  "projects": [{ "project": "work-log", "activeMs": 5400000, "sessions": 3, "commits": 2 }],
  "tasks": [{ "id": "ABC-123", "label": "ABC-123", "url": "https://…", "activeMs": 3600000, "issue": { "title": "…", "state": "進行中" } }],
  "sessions": [{ "id": "…", "title": "…", "project": "work-log", "tool": "claude", "start": "2026-10-04T01:00:00.000Z", "activeMs": 1800000, "commits": 1, "status": "done" }],
  "text": "人が読むための要約(プレーンテキスト)"
}
```

- `totals.usd` は `includeCost` が `true` のときだけ入ります。`tasks[].url` は無ければ `null`、`issue` は課題の情報が取れたときだけ入ります。
- `maxSessions` を超えたセッションは `sessions` から外れます(`text` では「ほか n セッション」)。

セッション終了の通知(`type: "session_end"`)の JSON:

```json
{
  "type": "session_end",
  "version": 1,
  "session": {
    "id": "…", "title": "…", "project": "work-log", "tool": "claude",
    "start": "2026-10-04T01:00:00.000Z", "end": "2026-10-04T01:30:00.000Z", "activeMs": 1800000, "commits": 1,
    "tasks": [{ "id": "ABC-123", "label": "ABC-123", "url": "https://…" }],
    "usd": 0.42
  }
}
```

受け取る側での検証の例(Node.js。本文は JSON に直す前の生のバイト列で計算します):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, headers, secret, toleranceSec = 300) {
  const ts = headers['x-worklog-timestamp'];
  const sig = headers['x-worklog-signature'] || '';
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false; // 古すぎる通知は捨てる
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

時刻も署名に含むので、同じ通知を後から使い回されても通りません。

### ドキュメントへの保存(Confluence / esa / Qiita Team / Obsidian)

チャットと違い、日報・週報を 1 つのページ(記事・ノート)にします。セッションは表にして、既定では 500 件まで載せます。

- 同じ日・週を送り直すと、新しいページを作らず、同じページを更新します。ページとの対応は、キャッシュのフォルダのファイルに覚えます(後述の「キャッシュ」)。相手側でページが消されていたときは、作り直します。
- 題名は `Work Log <期間>` です。
- 週の途中で送り直せば、その時点の内容に上書きされます。手で編集した内容も上書きされるので、注意してください。
- API は、リダイレクトを追わず、1 回のリクエストは 10 秒でタイムアウトします。

#### Confluence

Confluence Cloud の REST v2 で、ページとして保存します。

- 環境変数: `CONFLUENCE_BASE_URL`(`https://<site>.atlassian.net`。`/wiki` を付けてもよい)、`CONFLUENCE_EMAIL`、`CONFLUENCE_API_TOKEN`(メールアドレスと API トークンの Basic 認証)、`CONFLUENCE_SPACE_ID`(数字のスペース ID)、`CONFLUENCE_PARENT_ID`(任意。親ページの ID)。`WORKLOG_CONFLUENCE_BASE_ANY=1` は `atlassian.net` 以外を許すテスト用です。
- 新規は `POST /wiki/api/v2/pages`(本文は storage format)、更新は `PUT /wiki/api/v2/pages/{id}` です。更新では、保存してあるバージョンではなく、`GET` で今のバージョン番号を取って +1 します(画面で編集されていても競合しにくくするためです)。
- 「開く」リンクは、応答の `_links.webui` から作ります。
- `config.json` の `confluence`: `spaceId`、`parentId`(環境変数が優先)、`includeCost`、`maxSessions`。
- API トークンはサーバー側だけで使います。

#### esa

esa(esa.io)に記事として保存します。

- 環境変数: `ESA_ACCESS_TOKEN`、`ESA_TEAM`(`config.json` の `esa.team` でもよい)。
- 新規は `POST /v1/teams/{team}/posts`、更新は `PATCH /v1/teams/{team}/posts/{number}` です(本文は `{ "post": { name, category, body_md, wip, message } }`)。
- カテゴリは `config.json` の `esa.category`(既定は日報が `Work Log/日報`、週報が `Work Log/週報`)。`%{year}` `%{month}` `%{day}` `%{kind}` は、期間の開始日と「日報」「週報」に置き換えます。記事名に `/` を含めないよう、題名はハイフン区切りにします。
- 記事は公開(`wip` なし)で作ります。下書きにしたいときは `esa.wip` を `true` にします。更新のときは、esa の画面で Ship it した記事を下書きに戻さないよう、`wip` を送りません(`esa.wip` が `true` のときだけ送ります)。
- `config.json` の `esa`: `team`、`category`、`wip`、`includeCost`、`maxSessions`。

#### Qiita Team

Qiita Team の記事として保存します。誰にでも公開される `qiita.com` 本体には送りません。

- 環境変数: `QIITA_ACCESS_TOKEN`、`QIITA_TEAM_DOMAIN`(`<チーム名>.qiita.com`。`https://` や末尾の `/` は付けてもよい)。
- 新規は `POST /api/v2/items`、更新は `PATCH /api/v2/items/{id}` です。
- タグは「日報」「週報」です。`config.json` の `qiitateam.tags` に文字列の配列を書くと置き換えます(5 個まで)。
- 本文中の `@ユーザー名` は逃がしていないので、通知になる場合があります。
- `config.json` の `qiitateam`: `tags`、`includeCost`、`maxSessions`。

#### Obsidian

Vault のフォルダに、Markdown のノートを直接書きます。ネットワークは使いません。

- Vault は `OBSIDIAN_VAULT_DIR`(または `config.json` の `obsidian.vault`)、書き込み先のフォルダは `obsidian.folder`(既定 `Work Log`)です。
- 日報は `<フォルダ>/2026-10-04 日報.md`、週報は `<フォルダ>/2026-W40 週報.md` です。同じ期間を送り直すと、そのノートを上書きします(一時ファイルに書いてから置き換えます)。
- セッション終了の通知(`obsidian.notify` が `"session_end"` のとき)は、`<フォルダ>/2026-10-04 セッション.md` の末尾に 1 行足します。
- 安全のため、フォルダに `..` や絶対パス、`.` で始まる名前(`.obsidian` など)は使えません。書き込み先は、シンボリックリンクをたどった後も Vault の中でなければ、書きません。ファイル名は期間の日付だけから作ります。
- 「開く」リンクは `obsidian://open?vault=<Vault のフォルダ名>&file=<ノートのパス>` です。
- Vault を同期・共有しているときは、その相手にも届きます。
- `config.json` の `obsidian`: `vault`、`folder`、`includeCost`、`maxSessions`、`notify`。

### 日報・週報の内容

- 見出し: 日報は日付、週報は月曜から日曜までの期間です。
- 合計: 作業時間、セッション数、コミット数です。API 換算コストは `includeCost` を設定したときだけ載せます。
- プロジェクト別: 作業時間とセッション数、コミット数です。
- タスク: 紐付いた課題のタイトルと状態(取得できたもの)、リンクです。期間内に作業時間のあるタスクを、作業時間の長い順に並べます。
- セッション一覧: 開始時刻、タイトル、プロジェクト、時間、コミット数です。Codex のセッションには「(Codex)」と付けます。

集計の規則:

- 作業時間は、アクティビティの区間のうち期間に入る部分だけを数えます。
- コミットは、時刻が期間内のものだけを数えます。
- 作業時間もコミットも期間内に無いセッションは載せません。
- タイムゾーンは、画面ではブラウザのもの、CLI では `--tz`(無ければ環境変数 `TZ`)です。日付の境目はそのタイムゾーンの 0 時で、夏時間の切り替えにも対応します。

### 画面から送る

何も選んでいないときの右側(週の集計)に、設定した送り先ごとに、「今日の日報…」と「この週の週報…」のボタンが並びます。週報は、表示している週が対象です。Teams のボタンは「Teams(Workflows)に送る」、Google Chat のボタンは「Google Chat(Webhook)に送る」で、確認ダイアログにも同じ表示が出ます。

1. ボタンを押すと、確認ダイアログに、送る内容が読みやすい形で表示されます。
2. 「投稿する」を押したときだけ送ります。
3. プレビューの後に内容が変わったとき(セッションが進んだ場合など)は、送らずに、もう一度確認するよう求めます。
4. 送ったあとは、結果を表示します。投稿へのリンクが取れたときは「開く」リンクも出ます。画面の自動更新で描き直しても残ります(ページを再読み込みすると消えます)。

送り先が 1 つも設定されていないときは、ボタンの代わりに、設定を案内する文を表示します。チャンネルの参加者全員が読めるので、内容を確認してから送ってください。

### CLI から送る

```sh
node src/cli.js report [--week] [--date YYYY-MM-DD] [--tz <IANA名>] [--slack] [--discord] [--teams] [--google-chat] [--chatwork] [--mattermost] [--rocketchat] [--lineworks] [--webhook] [--confluence] [--esa] [--qiita-team] [--obsidian]
```

- 既定は今日の日報です。`--week` で、`--date`(省略すると今日)を含む週の週報にします。
- 内容はターミナルに表示します。
- 送り先のオプションを付けると、確認なしで送ります。複数付けると、`src/destinations.js` の一覧の順(Slack、Discord、Teams、Google Chat、Chatwork、Mattermost、Rocket.Chat、LINE WORKS、Webhook、Confluence、esa、Qiita Team、Obsidian)に送ります。cron などで定期的に送れます。
- 失敗したときは、メッセージを表示して exit 1 で終わります。先の送り先で失敗したときは、後の送り先には送りません。

例: 平日の 18 時に日報を送る(パスは環境に合わせてください)。

```
0 18 * * 1-5  cd <リポジトリのパス> && SLACK_WEBHOOK_URL=<Webhook の URL> node src/cli.js report --slack
0 18 * * 1-5  cd <リポジトリのパス> && DISCORD_WEBHOOK_URL=<Webhook の URL> node src/cli.js report --discord
0 18 * * 1-5  cd <リポジトリのパス> && TEAMS_WEBHOOK_URL=<Webhook の URL> node src/cli.js report --teams
0 18 * * 1-5  cd <リポジトリのパス> && GOOGLE_CHAT_WEBHOOK_URL=<Webhook の URL> node src/cli.js report --google-chat
0 18 * * 1-5  cd <リポジトリのパス> && OBSIDIAN_VAULT_DIR=<Vault のパス> node src/cli.js report --obsidian
```

### API

- `GET /api/report`: プレビューです。`target`(`slack` / `discord` / `teams` / `googlechat` / `chatwork` / `mattermost` / `rocketchat` / `lineworks` / `matrix` / `email` / `webhook` / `confluence` / `esa` / `qiitateam` / `obsidian`)、`period`(`day` / `week`)、`date`(`YYYY-MM-DD`)、`tz` を指定します。送る内容(`preview`)、プレーンテキストにしたもの(`previewText`)、内容の `hash`、合計、送り先の状態を返します。
- `POST /api/report`: `{ "target", "period", "date", "tz", "hash" }` を送ると、送信します。`hash` がプレビューのものと違うときは、送らずに 409 を返します。
- `target` を省略すると `slack` です。
- `/api/slack/report` は、`target=slack` と同じです(互換のために残しています)。

### セッション終了の通知

`slack.notify`、`discord.notify`、`teams.notify`、`googlechat.notify`、`chatwork.notify`、`mattermost.notify`、`rocketchat.notify`、`lineworks.notify`、`matrix.notify`、`email.notify`、`webhook.notify`、`obsidian.notify` が `"session_end"` で、その送り先が使える状態のとき、サーバーの起動中に hooks の `SessionEnd` を受けたセッションを、1 件ずつ送ります。複数設定すれば、すべてに送ります。hooks 連携(`hooks install`)が必要です。

- 内容: タイトル、プロジェクト、作業時間、コミット数、Codex の印、紐付いたタスクです。API 換算コストは `includeCost` を設定したときだけ載せます。Discord では、タイトルを embed の見出しにします。Teams では、タイトルを Adaptive Card の見出しにします。Google Chat では、タイトルを太字の 1 行目にします。汎用 Webhook には `type: "session_end"` の JSON を送り、Obsidian には、その日の「セッション.md」の末尾に 1 行足します。Confluence・esa・Qiita Team は、ページを作る送り先なので、通知は送りません。
- 終了から 2 時間以内のものだけ送ります。サーバーの停止中に終わったセッションを、起動後にまとめて送ることはありません。
- 同じ終了は、送り先ごとに二度送りません。送った記録は `slack-notified.json` に残します(Slack だけだった頃の記録も、そのまま使います)。送信に失敗したときも、その送り先には同じものを繰り返し送りません(警告をログに出します)。ほかの送り先には影響しません。
- 本文は秘匿情報をマスキングします。

### 秘匿情報

日報・週報、セッション終了の通知は、書式を整える前に秘匿情報をマスキングします。Discord の Markdown の記号を逃がすと、トークンの形が崩れて(`ghp_…` が `ghp\_…` になるなど)、後からでは見つけられないためです。整えた後の本文にも、もう一度マスキングを通します。課題へのコメントも同じ順です。`WORKLOG_NO_MASK=1` の対象外です。

### 動作確認

Slack、Discord、Teams、Google Chat の API には、この開発環境から接続できないため、実際のサービスでは確認していません。

- Slack: 公式 SDK(`@slack/web-api`、`@slack/webhook`)の形に合わせた偽サーバーとテスト(`test/slack.test.js`)でだけ確認しています。
- Discord: discord-api-types の型定義に合わせた偽サーバーとテスト(`test/discord.test.js`)でだけ確認しています。
- Teams: 偽サーバーとテスト(`test/teams.test.js`)でだけ確認しています。送るデータの形は、MicrosoftDocs/msteams-docs(`connectors-using.md`、`cards-format.md`)に合わせています。
- Google Chat: 偽サーバーとテスト(`test/googlechat.test.js`)でだけ確認しています。送るデータの形と制限は、Chat API の discovery document(`chat.googleapis.com` の `$discovery`、v1)と `@googleapis/chat` に合わせています。実際のスペースには接続できていません。

実際に使うときは、まず `report` コマンドで本文を確かめ、次にテスト用のチャンネルへ送ってみてください。

#### あとから加えた送り先・記録先・ログの取り込み元

次のうち、下の「実際に確認したもの」に書いたもの以外は、この開発環境からは実際のアカウント・サービス・ツールに接続できないため、偽サーバーとテストフィクスチャ(`test/fixtures/`)でだけ確認しています。実際のサービスでの動作は未確認です。確認の根拠は、各モジュールの先頭のコメントにも書いています。

実際に確認したもの(2026-10-04):

- ログの取り込み元: 実際のツールを手元の偽のモデルサーバーに向けて動かし(本物の AI サービスの認証情報は使っていません)、書かれたログを Work Log で読みました。そのログはテストフィクスチャとして残しています(`test/fixtures/{aider,codex,gemini,copilot}-real`)。
  - Aider 0.86.2(OpenAI 互換の偽サーバー): 複数行の `--message` の 2 行目が AI の応答として数えられていた、`/ask X` が 2 回数えられていた、の 2 点を直しました。
  - Codex CLI 0.160.0(Responses API の偽サーバー): 出力が新しい形式("Process exited with code N")になり、失敗した `git commit` がコミットとして数えられていたのを直しました。未確認: `apply_patch`・変更ファイル、対話画面(TUI)、`.zst`。
  - Gemini CLI 0.62.0(`GOOGLE_GEMINI_BASE_URL` の偽サーバー): 食い違いはありませんでした。プロジェクトのパス、依頼、コミット、トークンが一致しました。
  - Copilot CLI 1.0.91(`COPILOT_PROVIDER_BASE_URL` による BYOK モード、GitHub ログインなし): 依頼がすべて落ちていた(`parentAgentTaskId`)、再開後にトークンが二重に数えられていた(終了時の利用量は累積)、失敗したシェルコマンドが成功として数えられていた("<shellId: N completed with exit code N>" の新形式)、ロックのフォルダがセッションとして並んでいた、の 4 点を直しました。
  - Cursor: GUI アプリのため動かしていません。保存形式は引き続き非公式のものです。
- Google: OAuth のトークン取得先、Calendar API、Google Chat の Webhook に、偽の認証情報で実際に接続しました。エラーメッセージを `invalid_client` と `invalid_grant` で区別するようにし、Google Chat の 403 では URL が間違っているか削除されている旨を説明するようにしました。正しい認証情報での成功時の応答は未確認です。
- 実際の Claude Code のログから出力した `.ics` を Python の icalendar で読めることを確認しました。Obsidian 向けのノートは実際のフォルダに書き、markdown-it で描画して、悪意のあるタイトルが逃がされることを確認しました。汎用 Webhook は、この README の受け取り側の例で、正しい署名は通り、本文を改ざんすると弾かれることを確認しました。
- Mattermost(Docker の `mattermost/mattermost-preview`、実サーバー): `work-log report --mattermost` の Incoming Webhook の投稿で、見出し・リスト・逃がした Markdown が正しく描画されることを確認しました。タイトルに "@bob @channel" を含むセッションでは bob に通知が行かず(メンション数は 0 のまま)、対照として生の "@bob" を投稿したときは通知されました(1)。`username` の上書きは、サーバー設定 `EnablePostUsernameOverride` が有効でないと無視されることも分かりました(既定は無効)。
- Rocket.Chat 8.8(Docker の `rocketchat/rocket.chat` と MongoDB 8.0、実サーバー): Incoming Webhook の投稿で `*太字*` やリストが描画されることを確認しました。こちらの投稿は `mentions=[]` で、bob の `userMentions` は 0 のままでした。対照の生の "@bob" は `mentions=['bob']` になりました。Incoming インテグレーションの作成には、メッセージの成りすまし(message-impersonate)権限を持つユーザー(例: `rocket.cat`)が必要です。
- n8n 2.41.6(Docker の `n8nio/n8n`): Webhook トリガー(Raw Body 有効)と Code ノードのワークフローで、`X-WorkLog-Signature` を `"<時刻>.<本文>"` に対して検証しました。正しい鍵なら検証は成功し、誤った鍵なら失敗しました。日報の JSON の項目(`type`、`period`、`totals`、`sessions`)も受け取れました。
- 実際の Mattermost の確認で見つかった不具合を直しました。タイトルを 60 文字に切ってからマスキングしていたため、トークンの一部(例: `ghp_abcd…`)がマスクされずに残ることがありました。マスキングしてから切るようにし(`src/mask.js` の `clipMasked`)、キャッシュのバージョンを上げてセッションを読み直すようにしました。
- メール(Docker の `axllent/mailpit` v1.31.4、2026-10-05): `report --email` を、STARTTLS + AUTH PLAIN(自前の CA の証明書を `NODE_EXTRA_CA_CERTS` で検証)、最初から TLS(`smtps://` と `WORKLOG_SMTP_SECURE=1`)、TLS も認証も無い平文、の 3 通りで送りました。Mailpit の API で、件名の復号、宛先 2 件、From、text と HTML の両方、日本語、伏せたトークン、HTML の逃がし、余計なヘッダー(Bcc など)が無いこと、URL エンコードしたユーザー名(`user%2Bx` → `user+x`)を確かめ、HTML は Chromium で表示して見ました。件名に CR/LF と "Bcc:" を入れてもヘッダーが増えないこと、長い日本語の件名の復号、セッション終了の通知(`subjectPrefix` 付き)、証明書を確かめられないときは送らないこと、STARTTLS の無いサーバーへ手元以外の IP ではパスワードを送らないこと、TLS 専用のポートへ平文でつなぐとタイムアウトのエラーになることも確かめました。
- Matrix(Docker の `matrixdotorg/synapse` 1.162.0、`server_name=localhost`、既定のルーム v12): 送り手・bob・carol の 3 人のルームに、タイトルに "@room" と "@bob:localhost" を含む日報を送りました。bob の `/messages` で、`formatted_body`、空の `m.mentions`、本文の `@` が全角になっていることを確かめました。bob の `/sync` の `unread_notifications` と `/notifications` では、既定の `m.notice` は `notification_count` も `highlight_count` も増えず、`m.text` にすると `notification_count` だけが 1 増えました。対照として、`m.mentions` の無い同じ本文と本物のメンションではハイライトが増え、`m.mentions: {}` を付けると増えないことを確かめました。`rc_message` を厳しくして実際の 429 を起こし、同じ `txnId` で送り直して、8 件続けても二重にならないこと、間違ったトークン(401)と参加していないルーム(403)のエラー、セッション終了の通知も確かめました。
- Redmine(`redmine:6` = 6.1.5)と Gitea(28.0.0): 課題の取得とコメントの投稿(「課題管理サービス連携」の「動作確認」)、Redmine の作業時間の記録(`work-log sync --redmine-time`。作成 201、更新 204、削除 204、消えた ID の更新 404 は作り直し、2 回目は何も作らない、途中で 422 で止まっても続きから、`spent_on` が `redmine.timeZone` の日付)を実際のサーバーで確認しました。
- CalDAV(Radicale 3.8.1、Docker の `tomsquest/docker-radicale`、2026-10-05): `MKCALENDAR` で作ったカレンダーに `work-log sync --caldav` で、追加 3 件、2 回目は追加 0 件、タイトルの変更で更新 2 件、区間が消えたら削除 1 件。PROPFIND・REPORT と、Python の icalendar 7.3.0 で読んで確かめました。412 は 3 通りとも実物で起こして確かめました(カレンダー側で書き換えた予定の更新・削除、対応表を消した後の追加)。401(パスワード違い)と 409(無いカレンダー)の文面も確認しました。
- 書き出し(2026-10-05): CSV を pandas の `read_csv`、`.xlsx` を openpyxl 3.1.5 と pandas の `read_excel` で読み、列・日時・数値が一致することを確かめました。LibreOffice 25.8.7.3 の headless 変換で、式の注入対策(`'` を付けた `=HYPERLINK(…)` が文字列のまま)と、`.xlsx` の `=` で始まるタイトルが文字列のままであることを確かめました。
- Prometheus 3.15.0(Docker の `prom/prometheus`、`--network host`): targets が `up` になり、HTTP API で各指標が Work Log の `/api/sessions` と `/metrics` の値と一致すること、`"` と `\` を含むプロジェクト名のラベルが元の文字列に戻ること、`promtool check metrics` に警告・誤りが無いことを確かめました。
- 実際のサーバーでの確認で見つけた不具合を直しました。(1) Redmine の作業時間: `project_id` に識別子を渡すと 422 になるため、識別子は `GET /projects/{識別子}.json` で数値の ID に直してから送るようにしました。(2) Redmine: 既定データには「既定」の作業分類が無く、`activity_id` を省くと 422 になるため、既定の作業分類を探し、無ければ `redmine.activityId` の設定を求めるようにしました。(3) Redmine の Textile: 記号が記法として解釈されて崩れたため、セルを `<notextile>` で囲むようにしました。(4) メール: text の部分の改行が CRLF になっていませんでした。(5) メール: 手元のサーバーの判定が `127.0.0.1` だけで、`127.0.0.0/8` の範囲を手元と扱っていませんでした。(6) Matrix: ルーム v12 の ID はサーバー名の部分が無い形(`!abc…`)で、これを受け付けていませんでした。
- 未確認: Slack・Discord・Teams・Chatwork・LINE WORKS・Notion・Linear・Jira・Toggl・Clockify・Harvest・Confluence・esa・Qiita には、開発環境から接続できません。Jira の作業ログ(`--jira-worklog`)も偽のサーバーとテストでだけ確認しています。そのほか実物で未確認のものは、次のとおりです。メール: AUTH LOGIN しか提示しないサーバー・HELO しか知らないサーバー・宛先を断るサーバー、Gmail・Microsoft 365・SES などの実際のサービスと実際のメールソフトでの表示、SMTPUTF8(日本語のメールアドレス)、8BITMIME(本文は常に base64 で送るため、DATA の行頭の `.` の処理は本物のサーバーでは働く場面がありませんでした)。Matrix: Element など実際のクライアントでの表示、`matrix.org` など公開のホームサーバー、https のホームサーバー、暗号化されたルーム、サーバー名の付いた古い形のルーム ID。Redmine: 5.x 以前、プロジェクトごとに作業分類を変えている場合、コメントの長さの上限(255 文字に切り詰めて送ります)。Gitea: Forgejo。CalDAV: Nextcloud・iCloud・Fastmail の実物。書き出し: Microsoft Excel・Google スプレッドシート・Numbers での表示と取り込み。Prometheus: VictoriaMetrics・Grafana Agent など Prometheus 以外からの取得、OpenMetrics 形式での応答。

送り先:

- Chatwork(`test/chatwork.test.js`): 公式の API 定義(chatwork/api の RAML。`body` は必須で 1〜65535 文字、応答は `message_id`)と、公式の MCP サーバー(`@chatwork/mcp-server`)の実装(`X-ChatWorkToken` ヘッダー、form-urlencoded)に合わせています。未確認: API への実際の送信、制限(429)の応答ヘッダーの正確な名前(`retry-after` か `x-ratelimit-reset` のどちらかを見ています)。
- Mattermost(`test/mattermost.test.js`): mattermost/mattermost のソース(`webhook.go` のルートと JSON の本文、`incoming_webhook.go` の `text` / `username`(64 文字まで)/ `icon_url`(1024 文字まで)、`app/webhook.go` の自動分割)に合わせています。16383 文字は古いサーバーの上限です。実サーバーでも確認しました(上の「実際に確認したもの」)。
- Rocket.Chat(`test/rocketchat.test.js`): Rocket.Chat 7.0.0 のソース(`api.js` のルートと失敗時の JSON、`processWebhookMessage.ts`、`Message_MaxAllowedSize` の初期値 5000)に合わせています。Rocket.Chat 8.8 の実サーバーでも確認しました(上の「実際に確認したもの」)。未確認: Markdown の記号の逃がし方(確かな方法が見つからないので全角にしています)。
- LINE WORKS(`test/lineworks.test.js`): 公式のドキュメントには届かなかったため、LINE WORKS の API を使う公開パッケージ(`nworks`、`chat-adapter-lineworks`、`lineworks-mcp-server`)の実装(URL、JWT の項目、scope、`Authorization: Bearer`、本文の形、テキスト 2000 文字の制限)に合わせています。JWT の署名は、自前の鍵とテストで検証しています。未確認: 実際の LINE WORKS への送信、公式ドキュメントとの突き合わせ。
- 汎用 Webhook(`test/webhook.test.js`): 偽の fetch に対して、JSON の形と署名(`"<時刻>.<本文>"` の HMAC-SHA256)をテストで確認しています。受け取る側のサービス(Zapier など)では確認していません。
- Confluence(`test/confluence.test.js`): `confluence.js` 3.2.0(atlassian の OpenAPI から生成された SDK)の v2 の定義(`POST /wiki/api/v2/pages`、`PUT …/pages/{id}`、`GET …/pages/{id}`、応答の `id` / `status` / `version.number` / `_links.webui`)に合わせています。未確認: エラー応答の細かい形、同じスペースに同名のページがあるときのエラーの内容、429 の `Retry-After` の有無、`webui` を基準の URL(`…/wiki`)に足した URL の正しさ。
- esa(`test/esa.test.js`): `esa-node` 0.2.2 と esa gem 3.7.0 の中身(`https://api.esa.io/v1`、Bearer、作成・更新のパスと `{ post: … }` の包み方、記事の項目、429 の `Retry-After`)に合わせています。未確認: エラー応答の本文の形、同じカテゴリに同名の記事があるときのエラー、記事名に `/` を含めたときの扱い(題名はハイフン区切りにして避けています)。
- Qiita Team(`test/qiitateam.test.js`): qiita gem 1.6.0 と `qiita-js` 0.4.3 の中身(ホスト `<team>.qiita.com`、Bearer、`create_item` = `POST /api/v2/items`、`update_item` = `PATCH /api/v2/items/{id}`)に合わせています。未確認: 記事の項目(`title` / `body` / `tags` / `private`)の細かい仕様と必須かどうか、応答の `id` / `url`、エラー応答の本文の形、レート制限の応答、本文中の `@ユーザー名` が通知になるか。
- Obsidian(`test/obsidian.test.js`): 一時フォルダの Vault に実際に書いて確認しています(上書き、末尾への追記、フォルダの指定が Vault の外になるもの・外を指すシンボリックリンクの拒否)。未確認: `obsidian://open` の URI で Obsidian が実際に開くか。
- ページを作る送り先の共通部品(`src/docutil.js`、`src/docreport.js`)は、`test/docreport.test.js` と各送り先のテストで確認しています(同じ期間を送り直すと更新、相手側で消えていれば作り直し)。

記録先とカレンダー:

- `.ics`(`test/ical.test.js`): RFC 5545 の規則(CRLF、75 オクテットの折り返し、TEXT のエスケープ、UID、UTC の日時)を、出力の文字列に対するテストで確認しています。カレンダーアプリへの取り込みは試していません。
- Google カレンダー(`test/sync.test.js`): Calendar API v3 の discovery 文書(`https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest`、revision 20260925)の `events.insert` / `events.update` / `events.delete`、`Event` の形、OAuth のトークンの場所(`https://oauth2.googleapis.com/token`)に合わせています。未確認(実際の Google アカウントでは試していません): `refresh_token` での更新の応答、削除済みの予定に対する 410 の扱い、エラー応答の文言。
- Toggl Track(`test/sync.test.js`): 公式の文書はこの環境から読めなかったため、SDK の `toggl-track` 0.9.1 と `toggl-client` 3.7.2 の実装(`https://api.track.toggl.com/api/v9`、Basic 認証 `<token>:api_token`、`time_entries` の POST / PUT / DELETE、本文の項目、`GET me` の `default_workspace_id`)に合わせています。未確認: `tags` に無い名前を渡したときにタグが作られるか、エラー応答の形、利用制限の値(1 秒に 1 回程度を目安に間隔を空けています)。
- Clockify(`test/sync.test.js`): 公式の文書と API はこの環境から読めなかったため、`clockify-sdk` 0.1.1 と `clockify-ts` 1.2108.13 の実装と型(`https://api.clockify.me/api/v1`、`X-Api-Key`、`time-entries` の POST / PUT / DELETE、`GET /user` の `activeWorkspace`)に合わせています。未確認: `PUT` で省いた項目が消えるか(省かずに全部送っています)、エラー応答の形、地域ごとの API の場所。
- Harvest(`test/sync.test.js`): 公式の文書と API はこの環境から読めなかったため、`harvest-v2` 3.0.0 と `node-harvest-api` 1.0.6 の実装(`https://api.harvestapp.com/v2/time_entries`、`Authorization: Bearer` / `Harvest-Account-ID` / `User-Agent` のヘッダー、更新は `PATCH`)と、公式の古い文書(`harvesthq/api` の README)で `User-Agent` を求めていることに合わせています。未確認: 本文の `project_id` / `task_id` / `spent_date` / `hours` / `notes` の扱い(SDK は本文をそのまま渡すだけで、項目名は SDK からは確かめられていません)、開始・終了の時刻で記録する設定のアカウントで `hours` が受け付けられるか、エラー応答の形。

ログの取り込み元(`test/fixtures/` のサンプルログと、実際のツールが書いたログ `*-real` で確認):

- Gemini CLI(`test/gemini.test.js`): `google-gemini/gemini-cli` の `packages/core`(`chatRecordingService`、`chatRecordingTypes`、`storage`、`projectRegistry`。`@google/gemini-cli-core` 0.62)に合わせています。実際の Gemini CLI 0.62.0 のログでも確認しました(上の「実際に確認したもの」)。
- Copilot CLI(`test/copilot.test.js`): `@github/copilot` の同梱スキーマ(`schemas/session-events.schema.json`)と `app.js`(1.0.63)に合わせています。実際の Copilot CLI 1.0.91 のログでも確認しました(BYOK モードのみ。GitHub ログインした状態は未確認)。
- Aider(`test/aider.test.js`): `Aider-AI/aider` の `io.py`・`coders/base_coder.py`・`repo.py` と、prompt_toolkit の `FileHistory` に合わせています。実際の Aider 0.86.2 のログでも確認しました(上の「実際に確認したもの」)。
- Codex CLI: 実際の Codex CLI 0.160.0 のログで確認しました(上の「実際に確認したもの」)。
- Cursor(`test/cursor.test.js`): 保存形式は非公式です。オープンソースの読み取りツール(`cursor-history` 0.18、`cursor-chat-history-mcp` 0.2)の実装に合わせ、テストの中で同じ表の SQLite を作って確認しています(`node:sqlite` が使えない Node.js ではスキップします)。実際の Cursor は GUI アプリのため動かしておらず、Cursor の更新で読めなくなることがあります。

実際に使うときは、まず `--dry-run`(記録先)や `report` コマンド(送り先)、画面のプレビューで内容を確かめ、テスト用のチャンネル・カレンダー・ワークスペースで試してから、本番で使ってください。

## カレンダーと工数管理

作業のセッションを、カレンダーアプリに取り込める `.ics` や、表計算ソフト向けの CSV / Excel に書き出したり、Google カレンダー・Toggl Track・Clockify・Harvest・CalDAV・Redmine・Jira に記録したりできます。どちらも任意です。記録先は `src/sync/index.js` の一覧にあり、1 項目足せば増やせます。

### 予定の作り方

- 1 つの予定は、セッションの 1 つの区間(30 分以上空くと別の区間)です。`mergeSegments` を `true` にすると、セッションごとに 1 件にまとめます。
- 予定のキーは `<セッションID>-<区間の番号>`(まとめるときは `<セッションID>`)です。区間は後ろにしか増えないので、番号は変わりません。
- タイトルはセッションのタイトルです。説明には、プロジェクト、ツール、ブランチ、コミット(10 件まで)、タスクを入れます。秘匿情報はマスキングします。

### .ics の書き出し

外部には何も送りません。

```sh
node src/cli.js ical [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tz <IANA名>] [--out file]
```

- 期間を省くと過去 30 日です(最大 366 日)。`--out` を省くと標準出力に出します。
- 画面では、何も選んでいないときの右側に「カレンダー(.ics)を書き出す」リンクが出ます(表示している週が対象)。API は `GET /api/calendar.ics?from=&to=&tz=` です。
- RFC 5545 に合わせています。行末は CRLF、1 行 75 オクテットで折り返し(UTF-8 の文字の途中では切りません)、`\` `;` `,` と改行はエスケープします。UID は `<セッションID>-<区間の番号>@work-log` で固定なので、取り込み直しても重複しません。日時は UTC(`Z` 付き)で、長さ 0 の区間は終わりを 1 分後にします。

### 記録先への記録

| 記録先 | CLI のオプション | 環境変数 | `config.json` |
| --- | --- | --- | --- |
| Google カレンダー | `--gcal` | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`GOOGLE_CALENDAR_ID` | `gcal` |
| Toggl Track | `--toggl` | `TOGGL_API_TOKEN` | `toggl` |
| Clockify | `--clockify` | `CLOCKIFY_API_KEY` | `clockify` |
| Harvest | `--harvest` | `HARVEST_ACCESS_TOKEN`、`HARVEST_ACCOUNT_ID` | `harvest` |
| CalDAV | `--caldav` | `CALDAV_URL`、`CALDAV_USERNAME`、`CALDAV_PASSWORD` | `caldav` |
| Redmine(作業時間) | `--redmine-time` | `REDMINE_URL`、`REDMINE_API_KEY` | `redmine` |
| Jira(作業ログ) | `--jira-worklog` | `JIRA_BASE_URL`、`JIRA_EMAIL` + `JIRA_API_TOKEN`(または `JIRA_PAT`) | `jira` |

- 対象は、終わったセッションだけです。
- 画面では、何も選んでいないときの右側に、設定した記録先ごとに「この週を…に記録…」のボタンが出ます。押すと、追加・更新・削除の一覧を確認ダイアログに見せ、「記録する」を押したときだけ送ります。プレビューの後に内容が変わったときは、送らずに 409 を返します。
- CLI は、cron から使えるよう、確認なしで送ります。`--dry-run` は一覧を表示するだけです。複数の記録先を付けると、順に送ります。

```sh
node src/cli.js sync [--week] [--date YYYY-MM-DD] [--from … --to …] [--tz <IANA名>] --gcal|--toggl|--clockify|--harvest|--caldav|--redmine-time|--jira-worklog [--dry-run]
```

- 期間を省くと今日(`--week` で、`--date`(省略すると今日)を含む週)です。画面と API の既定は過去 7 日(最大 93 日)です。
- API は `GET /api/sync?target=&from=&to=&tz=` で下見(追加・更新・削除の一覧、`hash`、`previewText`)、`POST /api/sync`(`{ "target", "from", "to", "tz", "hash" }`)で記録です。`hash` がプレビューのものと違うときは 409 を返します。`GET /api/config` の `syncs` に、記録先ごとの状態(認証情報は含みません)があります。

#### 重複させない仕組みと削除の規則

- 送ったものは、キャッシュの `sync-<name>.json`(`sync-gcal.json` / `sync-toggl.json` / `sync-clockify.json` / `sync-harvest.json` / `sync-caldav.json` / `sync-redmine.json` / `sync-jira.json`)に、予定のキー → 相手側の ID と内容の hash として記録します。何度実行しても重複しません。
- 内容が変わった予定(区間が伸びた、タイトルが変わった)は更新します。相手側で消されていた(404 / 410)ときは、作り直します。
- 削除するのは、この対応表にある(Work Log が作った)もので、手元の区間が無くなったものだけです。手で作った予定・記録には触りません。
- セッションが課題との紐付けを失った(Redmine・Jira)ときは、すでに送った記録は相手側に残し、削除しません。紐付けが別の課題に変わった Jira は、古い課題の記録を消して作り直します。
- セッションごと見当たらないもの(Claude Code が古いログを自動で消した可能性があります)は、終わってから `KEEP_MISSING_AFTER_DAYS`(20 日)以内のものだけ削除します。それより古いものは残します。
- 1 件ずつ順に送り、送れたものから対応表に記録します。途中で失敗しても、次はその続きからになります。同じ記録先への送信は 1 本ずつで、同時に押されても二重に作りません。
- 通信は、リダイレクトを追わず、1 回のリクエストは 10 秒でタイムアウトします。429 のときは待ち時間を添えてエラーにします。

#### 設定

`~/.work-log/config.json` に、記録先ごとに書きます(任意)。どの記録先でも、次の 2 つを使えます。

- `mergeSegments`: `true` にすると、セッションごとに 1 件にまとめます。既定は区間ごとです。
- `minMinutes`: これより短い区間は記録しません(分)。既定は 1 です。

```json
{
  "gcal": { "calendarId": "<記録専用のカレンダーの ID>", "colorId": "9", "mergeSegments": false, "minMinutes": 1 },
  "toggl": { "workspaceId": 123456, "projects": { "work-log": 7890 } },
  "clockify": { "workspaceId": "<ID>", "projects": { "work-log": "<プロジェクト ID>" }, "tagIds": ["<タグ ID>"], "billable": false, "baseUrl": "https://api.clockify.me/api/v1" },
  "harvest": { "projectId": 1, "taskId": 2, "projects": { "work-log": { "projectId": 3, "taskId": 4 } }, "timeZone": "Asia/Tokyo" },
  "caldav": { "url": "http://localhost:5232/user/work-log/" },
  "redmine": { "projects": { "work-log": "wlb" }, "projectId": 1, "activityId": 9, "timeZone": "Asia/Tokyo" },
  "jira": { "apiVersion": 3 }
}
```

- Google カレンダー: `calendarId`(環境変数 `GOOGLE_CALENDAR_ID` でも可。記録専用のカレンダーを作って、その ID を指定するのがおすすめです)、`colorId`。認証は OAuth のリフレッシュトークンで、スコープは `calendar.events` か `calendar.app.created` です。
- Toggl Track: `workspaceId`(省くと既定のワークスペース)、`projects`(Work Log のプロジェクト名 → Toggl のプロジェクト ID)。タグは `work-log` とプロジェクト名を付けます。続けて送るときは、利用制限を避けて間隔を空けます。
- Clockify: `workspaceId`(省くと `GET /user` の `activeWorkspace`)、`projects`(プロジェクト名 → ID)、`tagIds`(ID の配列)、`billable`、`baseUrl`(EU などデータ保存地域を選んだワークスペースの API の場所。`WORKLOG_CLOCKIFY_API` が優先)。
- Harvest: `projectId` と `taskId`(必須)。`projects` に `{ "<プロジェクト名>": { "projectId", "taskId" } }` を書くと、プロジェクトごとに変えられます。時間は区間の長さを 0.01 時間に丸めて送ります。日付は `timeZone`(無ければこのマシンのタイムゾーン)の日付です。記録先が決まらない区間は、プレビューに「記録先の決まらないもの n 件」と出て、送りません。
- CalDAV・Redmine・Jira は、下の「CalDAV」「Redmine(作業時間)と Jira(作業ログ)」を参照してください。
- 認証情報はサーバー側だけで使い、ブラウザには渡しません。

#### CalDAV

- 1 つの予定は、カレンダーのコレクションの中の 1 つのファイル `<予定のキー>.ics` です(VEVENT 1 つ。中身と UID は `.ics` の書き出しと同じ)。追加は `PUT`(`If-None-Match: *`)、更新は `PUT`(`If-Match: <ETag>`。ETag が返らなければ条件なし)、削除は `DELETE`(`If-Match`)で、応答の ETag を `sync-caldav.json` に残します。
- 412(条件が合わない)のとき: 追加で起きたら同じ名前のものが既にあり(対応表を消した、別の PC から記録した)、更新・削除で起きたらカレンダーのアプリで書き換えられたか消されています。どちらも Work Log の作った予定なので、今の ETag を `GET` で取り直し、あれば上書き(削除)、無ければ作り直します。取り直した後でもまた 412 なら、止めて伝えます(同時に書き換えられています)。
- `CALDAV_URL`(`caldav.url` でも可)はカレンダーのコレクションの URL で、`https` だけです(`localhost` / `127.0.0.1` は `http` も可)。リダイレクトは追わない(認証情報を別の場所へ送らないため)ので、最終的な URL を書きます。記録専用のカレンダーを作っておくことをおすすめします。例:
  - Nextcloud: `https://<host>/remote.php/dav/calendars/<ユーザー>/<カレンダー>/`(アプリパスワード推奨)
  - iCloud: `https://pNN-caldav.icloud.com/<数字の ID>/calendars/<カレンダーの ID>/`(Apple ID とアプリ用パスワード。URL は `caldav.icloud.com` への PROPFIND で `current-user-principal` → `calendar-home-set` をたどって調べます)
  - Fastmail: `https://caldav.fastmail.com/dav/calendars/user/<メールアドレス>/<カレンダーの ID>/`(アプリパスワード)
  - Radicale: `http://localhost:5232/<ユーザー>/<カレンダー>/`
- Radicale などで直接作るときは `MKCALENDAR` を使います。

```sh
curl -u user:pass -X MKCALENDAR http://localhost:5232/user/work-log/
```

#### Redmine(作業時間)と Jira(作業ログ)

- Redmine(`--redmine-time`): `POST /time_entries.json` で作業時間を記録します。記録先は、セッションに Redmine の課題が紐付いていればその課題、無ければ `redmine.projects`(`{ "<Work Log のプロジェクト名>": Redmine のプロジェクトの ID か識別子 }`)か `redmine.projectId` で、どれも無ければ記録しません。識別子は ID に直してから送ります。作業分類は `redmine.activityId`(無ければ Redmine の既定の作業分類。既定が無ければ設定を求めます)。時間は 0.01 時間に丸め、コメントは 255 文字に切り詰め、日付は `redmine.timeZone`(無ければこのマシンのタイムゾーン)の日付です。記録はこの鍵の利用者のものになります。
- Jira(`--jira-worklog`): Jira の課題に紐付いたセッションだけを、その課題の作業ログ(`/rest/api/3/issue/{key}/worklog`。Server / Data Center は v2)に記録します。認証と接続先は課題の取得と同じで、API の版は `jira.apiVersion`(2 / 3)で変えられます。記録の ID は `<課題キー>:<作業ログの ID>` です。残り見積もりは Jira の既定(`adjustEstimate=auto`)のとおりに減ります。
- Backlog の実績時間は、記録先にしていません。Backlog の `actualHours` は課題に 1 つの数値しか無く、記録ごとの ID が無いためです。人の入力と区別できず、足し引きでは途中で止まったときに二重に数え、合計で上書きすると人の入力を消します(`src/sync/index.js` のコメント)。

### 表計算ソフト向けの書き出し(CSV / Excel)

外部には何も送りません。1 行は、作業の区間 1 つ(既定)か、セッション 1 つです。

```sh
node src/cli.js export --csv|--xlsx [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tz <IANA名>] [--per session] [--out file]
```

- 期間を省くと過去 30 日です。CSV は標準出力へ、`.xlsx` は `--out` か、端末でない標準出力へ書きます。API は `GET /api/export.csv` / `GET /api/export.xlsx`(`from`、`to`、`tz`、`unit=segment|session`)で、画面にもサイドバーに「CSV」「Excel(.xlsx)」のリンクが出ます。
- 列は、日付・開始・終了・作業時間(分)・プロジェクト・ツール・タイトル・タスク・コミット数・モデル・トークン数・API 換算(USD)・セッション ID です。文字列は秘匿情報を伏せてから書きます。
- 区間ごとのときは、トークンとコストを 1 時間ごとの集計から、その 1 時間と最も重なる区間に入れます。コミットは時刻の入る区間に入れます。区間の合計はセッションの合計と一致します。
- CSV は UTF-8(BOM 付き)・行末 CRLF・RFC 4180 の引用です。式の注入対策として、文字列のセルが `=` `+` `-` `@` タブ CR で始まるときは先頭に `'` を付けます(数値のセルには付けません)。`.xlsx` の文字列はインライン文字列のセルなので、`'` は付けずそのまま書きます。
- `.xlsx` は依存なしの自前の書き出しです(シート 1 枚。見出しは太字で固定、日付は日付のセル)。

### Prometheus の指標

`WORKLOG_METRICS=1` か `config.json` の `metrics.enabled` が `true` のときだけ、`GET /metrics`(`text/plain; version=0.0.4`)で返します(無効なときは 404)。サーバーは 127.0.0.1 だけで待ち受け、Host が `127.0.0.1` / `localhost` のときだけ応じます。

- 指標: `work_log_active_seconds_total`・`work_log_sessions_total`・`work_log_commits_total`(`project` / `tool` ごと)、`work_log_api_equivalent_usd_total`(`project` / `tool` / `model` ごと)、`work_log_tokens_total`(`model` / `type` ごと)、`work_log_in_progress_sessions`(gauge)です。ラベルの値は秘匿情報を伏せてからエスケープします。
- 値は手元に残っているログ全体の累計です。Claude Code は古いログを自動で消す(既定で 30 日)ので、消えた分だけ counter が減ることがあります(Prometheus は減少をリセットとして扱うので、`rate()` / `increase()` はそのまま使えます)。
- Docker の中の Prometheus から取るときは、`--network host` で動かし、targets に `127.0.0.1:<ポート>` を書きます(ブリッジのネットワークからは届きません)。

## 拡張のしかた

送り先・ログの取り込み元・記録先は、それぞれ 1 つの一覧(登録簿)にまとめています。サーバー・CLI・画面は一覧から作られるので、増やすときに他の場所を直す必要はありません。

- 日報・週報の送り先: `src/destinations.js` の `DESTINATIONS` に 1 項目足します(`name`、`label`、`flag`、`env`、クライアントのクラス、本文を作る関数、プレビュー用の関数など)。CLI のオプション、API の `target`、画面のボタン、通知の対象に反映されます。
- ログの取り込み元: `src/sources.js` の `SOURCES` に 1 項目足します(ログの場所と、一覧を作る関数、解析する関数)。
- カレンダー・工数管理の記録先: `src/sync/index.js` の `SYNCS` に 1 項目足します(クライアントのクラスは `src/sync/base.js` を継承します)。

## 各値の算出方法

- コミット数: Bash ツールで実行された `git commit` のうち、成功したものの数です。ヒアドキュメントの本文や文字列の中にある "git commit" は数えません。出力の `[branch hash] 件名` でハッシュを確認できたものと、エラーにならなかったがハッシュが出なかったもの(`-q` など)を数えます。失敗したもの(`nothing to commit` など)は数えません。
- 変更ファイル: Edit / Write / MultiEdit / NotebookEdit の対象ファイルです。重複は除き、プロジェクト配下のパスは相対パスで表示します。
- メッセージ数: ユーザーの実際の依頼文とアシスタントの応答の合計です。ツール結果やシステム通知は含みません。
- 作業種別・コンポーネント(自動抽出): API キーがなくても動くルールベースの推定です。
  - 作業種別は、タイトルと最初の 5 件の依頼文をキーワードで採点して決めます。種別は「バグ修正」「リファクタ」「テスト」「ドキュメント」「機能」「調査」です。該当がなければ、ファイル変更があれば「機能」、なければ「調査」になります。
  - コンポーネントは、変更ファイルのパスから上位ディレクトリ単位で推定します(最大 4 件)。
  - 要約は、最初の依頼と変更ファイル数・コミット数・コマンド実行回数から組み立てます。
- 作業種別・コンポーネント・要約(LLM): 詳細パネルの「LLM で要約」ボタンか `summarize` コマンドで明示的に実行したときだけ、Claude API を呼び出します。結果はタイトル、要約、作業種別、コンポーネントとして上記の自動抽出の代わりに表示します。送る内容は、プロジェクト名、ブランチ、変更ファイル、コミット数、依頼文、実行コマンドの抜粋、アシスタントの最終応答で、すべてマスキング済みです。
- マスキング: API キー、トークン、JWT、秘密鍵、`password=` などの代入、URL 内の認証情報、メールアドレスを置き換えます。要約の送信前と、画面に返す API 応答の両方に適用します。

## キャッシュ

`WORKLOG_CACHE_DIR`(既定 `~/.work-log`)に次のファイルを保存します。

- `sessions.json`: 解析結果です。mtime または size が変わったログファイルだけを再解析します。形式を変えたため(コスト計算用の利用量を追加)、更新後の初回起動時は全ログを再解析します。サブエージェントのログも対象です。
- `summaries.json`: LLM 要約です。内容(最終時刻とメッセージ数)が同じセッションは再要約しません。セッションがその後に進んでも、要約は表示し続け「セッション更新あり」と示します。再生成するのは、再要約ボタンまたは `--force` を使ったときだけです。
- `events.jsonl`: hooks から届いたイベントの追記先です。5MB を超えると、取り込み後に作り直します。
- `hooks-state.json`: `events.jsonl` の取り込み位置と、セッションごとの最新状態です。
- `server.json`: 起動中のサーバーのポートと PID です。フックが通知先を知るために使い、サーバーの終了時に削除します。
- `pricing.json`: 単価表の上書きです(任意、利用者が作成)。形式は「コスト」の「単価表の上書き」を参照してください。
- `config.json`: タスク管理連携の設定です(任意、利用者が作成)。形式は「タスク管理連携」の「設定」を参照してください。`remote`(Tailscale 経由で開く名前と利用者)は `remote setup` が書きます(「スマホ・別の端末から見る」を参照)。
- `links.json`: 詳細パネルから手で付け外ししたタスクです。
- `github.json`: GitHub の issue / PR の取得結果(ETag を含む)です。形式と再確認の間隔は「タスク管理連携」の「課題管理サービス連携」を参照してください。
- `tracker-<name>.json`: GitLab / Linear / Jira / Backlog / Notion / Redmine / Gitea の課題の取得結果です(`tracker-gitlab.json`、`tracker-redmine.json` など。GitLab は ETag を含む)。再確認の間隔は GitHub と同じです。
- `slack-notified.json`: セッション終了の通知の記録です(Slack / Discord / Teams / Google Chat / Chatwork / Mattermost / Rocket.Chat / LINE WORKS / Matrix / メール / 汎用 Webhook / Obsidian)。セッション終了の通知を送ったセッションを、送り先ごとに記録します(新しい 500 件まで)。形式は「送り先連携」の「セッション終了の通知」を参照してください。
- `confluence-pages.json` / `esa-pages.json` / `qiitateam-pages.json`: ページを作る送り先で、期間(日・週)と相手側のページ(記事)の対応です。同じ期間を送り直すと、新しく作らず、ここにあるページを更新します。消すと、次は新しいページを作ります。形式は「送り先連携」の「ドキュメントへの保存」を参照してください。
- `sync-<name>.json`: カレンダー・工数管理サービスへの記録の対応表です(`sync-gcal.json`、`sync-toggl.json`、`sync-clockify.json`、`sync-harvest.json`、`sync-caldav.json`、`sync-redmine.json`、`sync-jira.json`)。予定のキーと、相手側の ID(CalDAV は ETag も)・内容の hash を覚えます。重複させない、消えた区間を削除する、ために使います。形式は「カレンダーと工数管理」を参照してください。

## ディレクトリ構成

```
src/
  cli.js         コマンドラインの入口 (serve / scan / summarize / hooks / hook / report / ical / export / sync / remote)
  server.js      HTTP サーバー、API、ファイル監視、更新通知、フックからの通知の受け口
  store.js       ログの収集、JSON キャッシュ、要約の管理、セッション状態の判定、送り先・記録先の呼び出し
  paths.js       ログとキャッシュの場所
  remote.js      Tailscale 経由の公開設定。許可するホスト・利用者の判定、`tailscale serve` の操作、config.json の remote
  hook.js        hooks から呼ばれる受け口。events.jsonl への追記とサーバーへの通知
  live.js        events.jsonl の取り込みと、作業中/入力待ち/完了の判定
  install.js     Claude Code の settings.json へのフックの登録・削除
  git.js         Git 連携。リポジトリを読み取り専用で参照し、コミットをセッションに紐付ける
  tasks.js       タスク管理連携。ログからタスクIDを見つけ、リンク先を決める
  github.js      GitHub 連携。issue / PR の取得と作業記録コメントの投稿(trackers/base.js の共通部分を使う)
  worklog.js     課題に投稿する作業記録のコメント本文。Markdown / Jira 記法 / プレーンテキストの3書式
  trackers/      課題管理サービス連携
    base.js        共通部分。キャッシュ、再確認の間隔、API 制限中の停止、同時取得数、タイムアウト
    providers.js   GitLab / Linear / Jira / Backlog / Notion の取得とコメント投稿
    redmine.js     Redmine の課題の取得と注記の投稿(Markdown / Textile)
    gitea.js       Gitea / Forgejo の issue・プルリクエストの取得とコメントの投稿
    index.js       サービスの一覧、設定の反映、`ABC-123` 形式の振り分け、タスクへの課題情報の付与
  destinations.js 送り先の一覧(登録簿)。送り先を足すときは、ここに 1 項目足す
  slack.js       Slack への送信。Incoming Webhook と Bot トークン(chat.postMessage)に対応
  discord.js     Discord への送信。Webhook に対応(embeds で送る)
  teams.js       Teams への送信。Workflows と Incoming Webhook に対応(Adaptive Card で送る)
  googlechat.js  Google Chat への送信。スペースの Webhook に対応(テキストで送る)
  chatwork.js    Chatwork への送信。API トークンとルーム ID で投稿
  mattermost.js  Mattermost への送信。Incoming Webhook に対応
  rocketchat.js  Rocket.Chat への送信。Incoming Webhook に対応
  lineworks.js   LINE WORKS への送信。Bot API 2.0(サービスアカウントの JWT でトークンを取る)
  matrix.js      Matrix への送信。Client-Server API(既定は m.notice、m.mentions を空にする)
  email.js       メール(SMTP)での送信。依存なしの SMTP クライアント(STARTTLS / TLS、AUTH PLAIN / LOGIN)
  webhook.js     汎用 Webhook への送信。JSON を POST し、鍵があれば HMAC-SHA256 の署名を付ける
  confluence.js  Confluence Cloud へのページの保存(REST v2)。同じ期間は同じページを更新
  esa.js         esa への記事の保存。同じ期間は同じ記事を更新
  qiitateam.js   Qiita Team への記事の保存。同じ期間は同じ記事を更新
  obsidian.js    Obsidian の Vault へのノートの書き込み(ネットワークは使わない)
  docreport.js   日報・週報をページ形式(Markdown / Confluence の storage format)にする
  docutil.js     ページを作る送り先の共通部品(期間とページの対応 PageMap、タイムアウト付きの fetch、作成か更新か)
  report.js      日報・週報の集計と、送り先ごとの本文(Slack・Discord・Teams・Google Chat・Chatwork・Mattermost・Rocket.Chat・LINE WORKS・Matrix・メール・Webhook・ターミナル用)、セッション終了の通知の本文
  ical.js        カレンダー(.ics、RFC 5545)の書き出し
  export.js      表計算ソフト向けの書き出し(CSV と .xlsx。1 行 = 区間かセッション。式の注入対策)
  xlsx.js        依存なしの .xlsx(Office Open XML)の書き出し(ZIP も自前)
  metrics.js     Prometheus のテキスト形式の指標(GET /metrics)
  sync/          カレンダー・工数管理サービスへの記録
    index.js       記録先の一覧(登録簿)、下見(追加・更新・削除の一覧)、記録、対応表(sync-<name>.json)。記録先を足すときは、ここに 1 項目足す
    base.js        共通部分。設定、HTTP の送り方(10 秒で打ち切り・リダイレクトしない・429 の扱い)、送る間隔
    entries.js     セッションの区間から予定を組み立てる。期間の解釈
    gcal.js        Google カレンダー(Calendar API v3)
    toggl.js       Toggl Track(API v9)
    clockify.js    Clockify(API v1)
    harvest.js     Harvest(API v2)
    caldav.js      CalDAV(RFC 4791。ETag と 412 の扱い)
    redmine.js     Redmine の作業時間(time entries)
    jira.js        Jira の作業ログ(worklog)
  filter.js      セッション一覧の絞り込み(期間・プロジェクト・タグ・ツール・タスク・キーワード)
  parser.js      JSONL を 1 セッションの集計レコードに変換
  sources.js     ログの取り込み元の一覧(登録簿)。取り込み元を足すときは、ここに 1 項目足す。Codex を含む
  record.js      Claude Code 以外のログを、parser.js と同じ形のレコードにまとめる共通部品
  codex.js       Codex CLI のログ(rollout)を同じ集計レコードに変換。.zst の読み込みも担当
  gemini.js      Gemini CLI のログを同じ集計レコードに変換
  copilot.js     GitHub Copilot CLI のログを同じ集計レコードに変換
  aider.js       Aider のチャット履歴を同じ集計レコードに変換
  cursor.js      Cursor のチャットを同じ集計レコードに変換(非公式の形式。node:sqlite で読み取り)
  pricing.js     モデルの単価表と、利用量からの API 換算コストの計算。pricing.json による上書き
  tagger.js      ルールベースの作業種別・コンポーネント推定と要約
  summarizer.js  Claude API による要約 (オプトイン)
  mask.js        秘匿情報のマスキング
public/          ブラウザ UI (index.html, app.js, costs.js, tasks.js, style.css)
                 costs.js はコストビュー (KPI、日別の積み上げ棒、表)
                 tasks.js はタスクビュー (タスクごとの集計表)
test/            テスト (node --test。送り先・記録先・取り込み元ごとに <名前>.test.js)
  fixtures/      テスト用のサンプルログ (Claude Code のログと、aider / copilot / cursor / gemini のサンプル)
  dest-helpers.js  送り先のテストの共通部品
  doc-helpers.js   ドキュメント系の送り先のテストの共通部品
  *.test.js      parser / codex / gemini / copilot / aider / cursor / pricing / git / tasks / trackers / github / notion / hooks / store /
                 slack / discord / teams / googlechat / chatwork / mattermost / rocketchat / lineworks / matrix / email / webhook /
                 confluence / esa / qiitateam / obsidian / docreport / ical / export / metrics / caldav / redmine-gitea / sync / remote
docs/            ドキュメント (requirements.md)
```
