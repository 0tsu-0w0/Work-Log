#!/usr/bin/env node
// 使い方:
//   work-log                 サーバーを起動 (http://127.0.0.1:4317)
//   work-log scan            ログを解析してセッション一覧を表示
//   work-log summarize [ID]  LLMで要約(IDを省略すると未要約のものをすべて)
import { Store, defaultPaths } from './store.js';
import { createServer } from './server.js';
import { llmAvailable } from './summarizer.js';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'serve';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const store = new Store(defaultPaths());
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
} else if (cmd === 'serve') {
  const port = Number(flag('port') || process.env.PORT || 4317);
  const server = createServer(store);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Work Log: http://127.0.0.1:${port}  (${store.sessions().length}セッション / ${store.projectsDir})`);
    console.log(llmAvailable() ? 'LLM要約: 有効(詳細パネルのボタンで実行)' : 'LLM要約: 無効(ANTHROPIC_API_KEY を設定すると有効)');
  });
} else {
  console.error(`不明なコマンド: ${cmd}`);
  process.exit(1);
}
