// 日報・週報と通知の送り先の一覧。送り先を足すときは、ここに1行足す。
//   name: config.json のキー・API の target / label: 画面の表示名 / flag: CLI のオプション / env: 設定に使う主な環境変数
//   Client: status() / setConfig() / post(message) を持つクラス / report・sessionEnd: 書式(sessionEnd が無ければ通知は送らない)
//   plain: プレビューの本文をプレーンテキストに戻す / note: 確認画面に出す「誰が読めるか」
import { Slack } from './slack.js';
import { Discord } from './discord.js';
import { Teams } from './teams.js';
import { GoogleChat } from './googlechat.js';
import {
  toSlack, sessionEndMessage, plainFromMrkdwn, toDiscord, sessionEndDiscord, plainFromDiscord,
  toTeams, sessionEndTeams, plainFromTeams, toGoogleChat, sessionEndGoogleChat, plainFromGoogleChat,
} from './report.js';

const CHANNEL_NOTE = 'チャンネルの参加者全員が読めます。';

export const DESTINATIONS = [
  { name: 'slack', label: 'Slack', flag: '--slack', env: 'SLACK_WEBHOOK_URL', Client: Slack, report: toSlack, sessionEnd: sessionEndMessage, plain: plainFromMrkdwn, note: CHANNEL_NOTE },
  { name: 'discord', label: 'Discord', flag: '--discord', env: 'DISCORD_WEBHOOK_URL', Client: Discord, report: toDiscord, sessionEnd: sessionEndDiscord, plain: plainFromDiscord, note: CHANNEL_NOTE },
  { name: 'teams', label: 'Teams', flag: '--teams', env: 'TEAMS_WEBHOOK_URL', Client: Teams, report: toTeams, sessionEnd: sessionEndTeams, plain: plainFromTeams, note: CHANNEL_NOTE },
  { name: 'googlechat', label: 'Google Chat', flag: '--google-chat', env: 'GOOGLE_CHAT_WEBHOOK_URL', Client: GoogleChat, report: toGoogleChat, sessionEnd: sessionEndGoogleChat, plain: plainFromGoogleChat, note: 'スペースの参加者全員が読めます。' },
];

export const DEST_BY_NAME = Object.fromEntries(DESTINATIONS.map((d) => [d.name, d]));
