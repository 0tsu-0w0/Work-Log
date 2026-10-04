#!/usr/bin/env node
// 使い方:
//   work-log                 サーバーを起動 (http://127.0.0.1:4317)
//   work-log scan            ログを解析してセッション一覧を表示
//   work-log summarize [ID]  LLMで要約(IDを省略すると未要約のものをすべて)
//   work-log report [--week] [--date YYYY-MM-DD] [--slack] [--discord] [--teams] [--google-chat] …  日報・週報を表示(送り先のオプションで送る。一覧は destinations.js)
//   work-log ical [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out file]  カレンダー(.ics)を書き出す(省くと過去30日、標準出力へ)
//   work-log sync [--week] [--date YYYY-MM-DD] [--from … --to …] --gcal|--toggl|--clockify|--harvest [--dry-run]
//                            終わったセッションをカレンダー・工数管理サービスに記録する(確認なし。一覧は sync/index.js)
//   work-log hooks install   Claude Code の hooks に登録(uninstall / status も可)
//   work-log hook            hooks から呼ばれる受け口(手動では使わない)
import { defaultPaths } from './paths.js';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'serve';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// フックは会話のたびに呼ばれるので、ログの走査などはせず最小限の処理で抜ける
if (cmd === 'hook') {
  try {
    const { handleHook, readStdin } = await import('./hook.js');
    await handleHook(await readStdin(), { cacheDir: defaultPaths().cacheDir });
  } catch (err) {
    process.stderr.write(`[work-log] ${err.message}\n`);
  }
  process.exit(0);
}

if (cmd === 'hooks') {
  const { install, uninstall, status, settingsPath } = await import('./install.js');
  const sub = args[1] || 'status';
  const file = flag('settings') || settingsPath();
  const dryRun = args.includes('--dry-run');
  try {
    if (sub === 'install') {
      const r = await install({ file, dryRun });
      console.log(`${dryRun ? '[dry-run] ' : ''}${r.file} に登録しました: ${r.events.join(', ')}`);
      if (dryRun) console.log(JSON.stringify(r.settings.hooks, null, 2));
      else console.log('次に起動する Claude Code のセッションから記録されます。');
    } else if (sub === 'uninstall') {
      const r = await uninstall({ file, dryRun });
      console.log(r.removed.length ? `${dryRun ? '[dry-run] ' : ''}${r.file} から削除しました: ${r.removed.join(', ')}` : '登録されていません。');
    } else if (sub === 'status') {
      const r = await status({ file });
      if (r.error) throw new Error(r.error);
      console.log(r.events.length ? `登録済み(${r.file}): ${r.events.join(', ')}` : `未登録(${r.file})。work-log hooks install で登録できます。`);
    } else {
      throw new Error(`不明なサブコマンド: ${sub}(install / uninstall / status)`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  process.exit(0);
}

const { Store } = await import('./store.js');
const { createServer } = await import('./server.js');
const { llmAvailable } = await import('./summarizer.js');
const { defaultSourceDirs } = await import('./sources.js');
const store = new Store({ ...defaultPaths(), sourceDirs: defaultSourceDirs() });
const scanResult = await store.scan();

if (cmd === 'scan') {
  console.log(`${scanResult.total}ファイル(更新 ${scanResult.changed}) / ${store.projectsDir}`);
  for (const s of store.sessions()) {
    const start = new Date(s.start).toLocaleString();
    console.log(`${start}  [${s.project}] ${s.displayTitle}  (${s.messageCount}msg, ${s.changedFiles.length}files, ${s.commits}commits, ${s.workType})`);
  }
} else if (cmd === 'summarize') {
  if (!llmAvailable()) {
    console.error('ANTHROPIC_API_KEY を設定してください');
    process.exit(1);
  }
  const ids = args[1] ? [args[1]] : store.sessions().filter((s) => s.summarySource !== 'llm' && s.status === 'done').map((s) => s.id);
  for (const id of ids) {
    try {
      const s = await store.summarize(id, { force: args.includes('--force') });
      console.log(`✓ ${id} ${s.displayTitle}`);
    } catch (err) {
      console.error(`✗ ${id} ${err.message}`);
    }
  }
} else if (cmd === 'report') {
  // cron などから定期的に送れるよう、--slack は確認なしで送る(本文はマスキング済み)
  const { plainFromMrkdwn } = await import('./report.js');
  try {
    const params = { period: args.includes('--week') ? 'week' : 'day', date: flag('date'), tz: flag('tz') || process.env.TZ, waitMs: 8000 };
    const { DESTINATIONS, DEST_BY_NAME } = await import('./destinations.js');
    const targets = DESTINATIONS.filter((d) => args.includes(d.flag)).map((d) => d.name);
    console.log(plainFromMrkdwn((await store.report({ ...params, target: 'slack' })).preview));
    for (const t of targets) {
      const r = await store.report({ ...params, target: t });
      const sent = await store.destinations[t].post(r.message);
      console.log(`${DEST_BY_NAME[t].label} に送りました${sent.url ? `: ${sent.url}` : ''}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (cmd === 'ical') {
  try {
    const r = store.calendar({ from: flag('from'), to: flag('to'), tz: flag('tz') || process.env.TZ });
    const out = flag('out');
    if (out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(out, r.ics);
      console.error(`${out} に書き出しました(${(r.ics.match(/^BEGIN:VEVENT/gm) || []).length}件)`);
    } else {
      process.stdout.write(r.ics);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (cmd === 'sync') {
  // cron などから定期的に記録できるよう、確認なしで送る(--dry-run は内容を表示するだけ)
  try {
    const { SYNCS } = await import('./sync/index.js');
    const { periodRange, validTimeZone, todayIn } = await import('./report.js');
    const targets = SYNCS.filter((s) => args.includes(s.flag));
    if (!targets.length) throw new Error(`記録先を指定してください(${SYNCS.map((s) => s.flag).join(' / ')})`);
    const tz = validTimeZone(flag('tz') || process.env.TZ);
    let range = { from: flag('from'), to: flag('to'), tz };
    if (!range.from && !range.to) {
      const r = periodRange({ period: args.includes('--week') ? 'week' : 'day', date: flag('date') || todayIn(tz), timeZone: tz });
      range = { from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(), tz };
    }
    const dryRun = args.includes('--dry-run');
    for (const t of targets) {
      const plan = await store.sync(t.name, range);
      console.log(`${dryRun ? '[dry-run] ' : ''}${t.label}(${plan.status.destination})`);
      console.log(plan.previewText);
      if (dryRun || !(plan.create.length + plan.update.length + plan.delete.length)) continue;
      const r = await store.postSync({ target: t.name, ...range }, plan.hash);
      console.log(`${t.label} に記録しました: 追加 ${r.created}件・更新 ${r.updated}件・削除 ${r.deleted}件`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (cmd === 'serve') {
  const port = Number(flag('port') || process.env.PORT || 4317);
  const server = createServer(store);
  const shutdown = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Work Log: http://127.0.0.1:${port}  (${store.sessions().length}セッション / ${store.projectsDir})`);
    console.log(llmAvailable() ? 'LLM要約: 有効(詳細パネルのボタンで実行)' : 'LLM要約: 無効(ANTHROPIC_API_KEY を設定すると有効)');
  });
} else {
  console.error(`不明なコマンド: ${cmd}`);
  process.exit(1);
}
