import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexText, parseCodexFile, commandFromArgs, filesFromPatch } from '../src/codex.js';
import { setPricingOverrides, costOf, modelFamily } from '../src/pricing.js';
import { Store } from '../src/store.js';
import { filterSessions } from '../src/server.js';

const ID = '0199a0b1-1111-7222-8333-444455556666';
const L = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
const usage = (input, cached, output, total) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total });

// codex-rs の rollout 形式(session_meta / turn_context / response_item / event_msg)
export const ROLLOUT = [
  L('2026-10-04T01:00:00.000Z', 'session_meta', { id: ID, timestamp: '2026-10-04T01:00:00.000Z', cwd: '/home/dev/shop', originator: 'codex_cli_rs', cli_version: '0.160.0', git: { commit_hash: 'abc', branch: 'feat/cart', repository_url: 'git@github.com:dev/shop.git' } }),
  L('2026-10-04T01:00:01.000Z', 'turn_context', { cwd: '/home/dev/shop', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-5-codex' }),
  L('2026-10-04T01:00:01.000Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/home/dev/shop</cwd>\n</environment_context>' }] }),
  L('2026-10-04T01:00:02.000Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'カートの合計金額のバグを直して' }] }),
  L('2026-10-04T01:00:02.000Z', 'event_msg', { type: 'user_message', message: 'カートの合計金額のバグを直して' }),
  L('2026-10-04T01:00:10.000Z', 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'x' }),
  L('2026-10-04T01:00:12.000Z', 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /home/dev/shop/src/cart.ts\n@@\n-a\n+b\n*** Add File: src/cart.test.ts\n+x\n*** End Patch' }),
  L('2026-10-04T01:00:13.000Z', 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'Success. Updated the following files:\nM src/cart.ts' }),
  L('2026-10-04T01:00:15.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: usage(12000, 8000, 900, 12900), last_token_usage: usage(12000, 8000, 900, 12900), model_context_window: 272000 } }),
  // 同じ累計の token_count がもう一度届く(数えない)
  L('2026-10-04T01:00:15.500Z', 'event_msg', { type: 'token_count', info: { total_token_usage: usage(12000, 8000, 900, 12900), last_token_usage: usage(12000, 8000, 900, 12900), model_context_window: 272000 } }),
  L('2026-10-04T01:00:20.000Z', 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git add -A && git commit -m "fix cart total"'], workdir: '/home/dev/shop' }), call_id: 'c2' }),
  L('2026-10-04T01:00:21.000Z', 'event_msg', { type: 'exec_command_end', call_id: 'c2', turn_id: 't1', command: ['bash', '-lc', 'git commit'], cwd: '/home/dev/shop', parsed_cmd: [], aggregated_output: '[feat/cart 9f8e7d6] fix cart total\n 2 files changed', exit_code: 0, duration: { secs: 0, nanos: 1 } }),
  L('2026-10-04T01:00:21.000Z', 'response_item', { type: 'function_call_output', call_id: 'c2', output: '[feat/cart 9f8e7d6] fix cart total\n 2 files changed' }),
  L('2026-10-04T01:00:30.000Z', 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git commit -q -m again'] }), call_id: 'c3' }),
  L('2026-10-04T01:00:31.000Z', 'response_item', { type: 'function_call_output', call_id: 'c3', output: JSON.stringify({ output: 'nothing to commit', metadata: { exit_code: 1 } }) }),
  L('2026-10-04T01:00:40.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合計の計算を直してコミットしました。' }] }),
  L('2026-10-04T01:00:40.000Z', 'event_msg', { type: 'agent_message', message: '合計の計算を直してコミットしました。' }),
  L('2026-10-04T01:00:41.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: usage(30000, 20000, 1500, 31500), last_token_usage: usage(18000, 12000, 600, 18600), model_context_window: 272000 } }),
].join('\n');

test('Codex の rollout をセッションに変換する', () => {
  const s = parseCodexText(ROLLOUT, { file: `/x/rollout-2026-10-04T10-00-00-${ID}.jsonl` });
  assert.equal(s.tool, 'codex');
  assert.equal(s.id, ID);
  assert.equal(s.project, 'shop');
  assert.equal(s.gitBranch, 'feat/cart');
  assert.equal(s.title, 'カートの合計金額のバグを直して');
  assert.deepEqual(s.prompts, ['カートの合計金額のバグを直して']); // 差し込まれた環境情報は依頼にしない
  assert.equal(s.assistantMessages, 1);
  assert.equal(s.messageCount, 2);
  assert.deepEqual(s.models, ['gpt-5-codex']);
  assert.deepEqual(s.changedFiles, ['src/cart.ts', 'src/cart.test.ts']);
  assert.deepEqual(s.toolCalls, { apply_patch: 1, shell: 2 });
  // exec_command_end と function_call_output の両方があっても1回だけ数え、失敗したコミットは数えない
  assert.equal(s.commits, 1);
  assert.equal(s.commitAttempts, 2);
  assert.deepEqual(s.commitList.map((c) => [c.hash, c.branch, c.subject]), [['9f8e7d6', 'feat/cart', 'fix cart total']]);
  assert.equal(s.start, '2026-10-04T01:00:00.000Z');
  assert.equal(s.end, '2026-10-04T01:00:40.000Z');
  // input_tokens はキャッシュ分を含むので差し引く。重複した token_count は数えない
  assert.deepEqual(s.tokens, { input: 4000 + 6000, output: 1500, cacheRead: 20000, cacheCreation: 0 });
  assert.deepEqual(s.usage, { '2026-10-04T01|gpt-5-codex||': [10000, 1500, 20000, 0, 0, 0] });
});

test('応答ごとの token_usage_record があればそちらを使う', () => {
  const text = [
    L('2026-10-04T01:00:00Z', 'session_meta', { id: ID, timestamp: '2026-10-04T01:00:00Z', cwd: '/r' }),
    L('2026-10-04T01:00:01Z', 'turn_context', { cwd: '/r', model: 'gpt-5.1-codex' }),
    L('2026-10-04T01:00:02Z', 'event_msg', { type: 'user_message', message: 'hi' }),
    L('2026-10-04T01:00:03Z', 'token_usage_record', { thread_id: ID, turn_id: 't', session_id: ID, root_turn_id: 't', response_id: 'r1', usage: { ...usage(100, 40, 10, 110), cache_write_input_tokens: 5 }, turn_token_usage: usage(100, 40, 10, 110), thread_token_usage: usage(100, 40, 10, 110) }),
    L('2026-10-04T01:00:03Z', 'event_msg', { type: 'token_count', info: { total_token_usage: usage(999, 0, 999, 1998), last_token_usage: usage(999, 0, 999, 1998) } }),
  ].join('\n');
  const s = parseCodexText(text, { file: '/x/a.jsonl' });
  assert.deepEqual(s.usage, { '2026-10-04T01|gpt-5.1-codex||': [60, 10, 40, 5, 0, 0] });
});

test('旧形式(行に type/payload の包みが無い)も読む', () => {
  const text = [
    JSON.stringify({ id: ID, timestamp: '2025-06-01T01:00:00.000Z', instructions: null, git: { branch: 'main' } }),
    JSON.stringify({ record_type: 'state' }),
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'READMEを書いて' }] }),
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'はい' }] }),
  ].join('\n');
  const s = parseCodexText(text, { file: '/x/rollout-2025-06-01T10-00-00-abc.jsonl' });
  assert.equal(s.id, ID);
  assert.equal(s.gitBranch, 'main');
  assert.deepEqual(s.prompts, ['READMEを書いて']);
  assert.equal(s.start, '2025-06-01T01:00:00.000Z');
});

test('シェル引数とパッチの読み取り', () => {
  assert.equal(commandFromArgs(JSON.stringify({ command: ['bash', '-lc', 'ls -la'] })), 'ls -la');
  assert.equal(commandFromArgs({ command: ['git', 'status'] }), 'git status');
  assert.equal(commandFromArgs(JSON.stringify({ cmd: 'npm test' })), 'npm test');
  assert.deepEqual(filesFromPatch('*** Delete File: a.js\n*** Update File: b.js\n*** Move to: c.js'), ['a.js', 'b.js', 'c.js']);
});

test('利用者の単価表で OpenAI のモデルを計算する', (t) => {
  t.after(() => setPricingOverrides({}));
  assert.equal(costOf('gpt-5-codex', [1e6, 0, 0, 0, 0, 0]), null); // 組み込みの単価は持たない
  assert.equal(modelFamily('gpt-5-codex'), 'OpenAI');
  setPricingOverrides({ 'gpt-5': { input: 2, output: 8 }, broken: { input: 'x' } });
  assert.equal(costOf('gpt-5-codex', [1e6, 1e6, 1e6, 0, 0, 0]), 2 + 8 + 0.2);
  assert.equal(costOf('gpt-5', [1e6, 0, 0, 0, 0, 0]), 2);
  assert.equal(modelFamily('gpt-5-codex'), 'OpenAI');
  assert.equal(costOf('broken', [1, 0, 0, 0, 0, 0]), null);
  // Claude の単価も上書きできる(価格改定への追従)
  setPricingOverrides({ 'claude-opus-5-5': { input: 1, output: 1 } });
  assert.equal(costOf('claude-opus-5-5', [1e6, 0, 0, 0, 0, 0]), 1);
});

test('Codex のログ(圧縮を含む)を Claude Code のログと一緒に集める', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, 'codex', 'sessions', '2026', '10', '04');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, `rollout-2026-10-04T10-00-00-${ID}.jsonl`), ROLLOUT);
  const oldId = '0199a0b1-0000-7000-8000-000000000001';
  const old = ROLLOUT.replaceAll(ID, oldId).replaceAll('2026-10-04T01', '2026-09-20T01');
  const oldDir = path.join(root, 'codex', 'sessions', '2026', '09', '20');
  await mkdir(oldDir, { recursive: true });
  if (typeof zlib.zstdCompressSync === 'function') {
    await writeFile(path.join(oldDir, `rollout-2026-09-20T10-00-00-${oldId}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(old)));
  } else {
    await writeFile(path.join(oldDir, `rollout-2026-09-20T10-00-00-${oldId}.jsonl`), old);
  }
  await mkdir(path.join(root, 'cache'), { recursive: true });
  await writeFile(path.join(root, 'cache', 'pricing.json'), JSON.stringify({ 'gpt-5-codex': { input: 1, output: 10, cacheRead: 0.1 } }));
  t.after(() => setPricingOverrides({}));

  const store = new Store({ projectsDir: path.join(root, 'none'), cacheDir: path.join(root, 'cache'), codexDir: path.join(root, 'codex') });
  const r = await store.scan();
  assert.equal(r.total, 2);
  const sessions = store.sessions();
  assert.deepEqual(sessions.map((s) => [s.id, s.tool]), [[ID, 'codex'], [oldId, 'codex']]);
  // 単価表に従ってコストを計算する: 入力 10000 × $1 + 出力 1500 × $10 + 読込 20000 × $0.1
  assert.ok(Math.abs(sessions[0].cost.usd - (10000 * 1 + 1500 * 10 + 20000 * 0.1) / 1e6) < 1e-12);
  assert.deepEqual(store.costs({ tool: 'codex' }).buckets.map((b) => b.family), ['OpenAI', 'OpenAI']);
  assert.equal(store.costs({ tool: 'claude' }).buckets.length, 0);
  assert.equal(filterSessions(sessions, { tool: 'codex' }).length, 2);
  assert.equal(filterSessions(sessions, { tool: 'claude' }).length, 0);
  assert.equal((await parseCodexFile(path.join(day, `rollout-2026-10-04T10-00-00-${ID}.jsonl`))).commits, 1);
});

// 本物の Codex CLI 0.160.0(codex exec)が書いた rollout(偽の Responses API サーバーにつないで動かした。パスだけ置き換えた)
//   01a1074f…: 1回目の依頼で exec_command の git commit が成功(2bd9b9f)、resume した2回目は変更が無く git commit が失敗(終了コード1)
//   01a10751…: 別のセッションで git commit が成功(43a324b)
// この版の exec では event_msg の user_message は書かれず、コマンドの結果は item_completed(CommandExecution)と
// function_call_output("Process exited with code N")に入る
test('本物の Codex CLI の rollout を読む', async () => {
  const day = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-real', 'sessions', '2026', '10', '04');
  const a = await parseCodexFile(path.join(day, 'rollout-2026-10-04T14-26-43-01a1074f-59c4-7451-a3b7-5a9dabc7becc.jsonl'));
  assert.equal(a.id, '01a1074f-59c4-7451-a3b7-5a9dabc7becc');
  assert.equal(a.cwd, '/home/dev/shop');
  assert.equal(a.project, 'shop');
  assert.deepEqual(a.prompts, ['hello.txt を作ってコミットして', '変更なしで空のコミットを試して']);
  assert.equal(a.assistantMessages, 2);
  assert.deepEqual(a.models, ['gpt-5-codex']);
  assert.deepEqual(a.toolCalls, { exec_command: 2 });
  assert.deepEqual(a.commands, ['printf \'hello 1\\n\' > hello1.txt && git add -A && git commit -m "add hello1"', 'git commit -m "empty attempt"']);
  // 失敗したコミットは数えない
  assert.equal(a.commitAttempts, 2);
  assert.equal(a.commits, 1);
  assert.deepEqual(a.commitList, [{ hash: '2bd9b9f', branch: 'main', subject: 'add hello1', at: '2026-10-04T14:26:43.747Z' }]);
  assert.deepEqual(a.quietCommits, []);
  assert.equal(a.start, '2026-10-04T14:26:43.285Z');
  assert.equal(a.end, '2026-10-04T14:28:54.470Z');
  // 応答4回 × (入力 3000 うちキャッシュ 1000、出力 200)
  assert.deepEqual(a.tokens, { input: 8000, output: 800, cacheRead: 4000, cacheCreation: 0 });
  assert.deepEqual(a.usage, { '2026-10-04T14|gpt-5-codex||': [8000, 800, 4000, 0, 0, 0] });

  const b = await parseCodexFile(path.join(day, 'rollout-2026-10-04T14-29-01-01a10751-7582-7000-bd3e-eaec7a67a7e6.jsonl'));
  assert.deepEqual(b.prompts, ['もう一つファイルを足してコミットして']);
  assert.deepEqual(b.commitList.map((c) => [c.hash, c.subject]), [['43a324b', 'add hello2']]);
  assert.equal(b.commits, 1);
  assert.deepEqual(b.tokens, { input: 4000, output: 400, cacheRead: 2000, cacheCreation: 0 });
});
