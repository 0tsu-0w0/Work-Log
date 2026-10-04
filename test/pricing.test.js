import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { priceFor, costOf, modelFamily, sessionCost } from '../src/pricing.js';
import { parseSessionText } from '../src/parser.js';
import { Store } from '../src/store.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const M = 1e6;

test('モデルIDの表記ゆれを吸収して単価を引く', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('claude-opus-4-5-20251101').input, 5);
  assert.equal(priceFor('claude-opus-4-20250514').input, 15); // claude-opus-4-5 と取り違えない
  assert.equal(priceFor('claude-opus-4-1-20250805').output, 75);
  assert.equal(priceFor('claude-sonnet-4-5[1m]').input, 3);
  assert.equal(priceFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0').input, 3);
  assert.equal(priceFor('claude-3-5-haiku-20241022').input, 0.8);
  assert.equal(priceFor('claude-fable-5').cacheRead, 1);
  assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor('gpt-5'), null);
  assert.equal(modelFamily('claude-sonnet-5-5'), 'Sonnet');
  assert.equal(modelFamily('unknown'), 'その他');
});

test('トークン種別ごとの単価', () => {
  const t = (i) => [0, 0, 0, 0, 0, 0].map((_, k) => (k === i ? M : 0));
  close(costOf('claude-opus-5-5', t(0)), 4); // 入力
  close(costOf('claude-opus-5-5', t(1)), 20); // 出力
  close(costOf('claude-opus-5-5', t(2)), 0.2); // キャッシュ読み込み(0.05倍)
  close(costOf('claude-opus-5-5', t(3)), 5); // 5分キャッシュ書き込み(1.25倍)
  close(costOf('claude-opus-5-5', t(4)), 8); // 1時間キャッシュ書き込み(2倍)
  close(costOf('claude-sonnet-4-6', t(2)), 0.3); // 0.1倍
  close(costOf('claude-opus-5-5', [0, 0, 0, 0, 0, 3]), 0.03); // Web検索 $10/1000回
});

test('fast モードと US 推論の割増', () => {
  close(costOf('claude-opus-5-5', [M, M, 0, 0, 0, 0], { fast: true }), 48);
  close(costOf('claude-opus-5-5', [0, 0, M, 0, 0, 0], { fast: true }), 0.4); // キャッシュの倍率は fast 単価に掛かる
  close(costOf('claude-opus-4-7', [M, 0, 0, 0, 0, 0], { fast: true }), 5); // fast 非対応は通常単価
  close(costOf('claude-opus-5-5', [M, 0, 0, 0, 0, 0], { us: true }), 4.4);
  close(costOf('claude-opus-4-5', [M, 0, 0, 0, 0, 0], { us: true }), 5); // 4.5 以前は対象外
  assert.equal(costOf('mystery', [M, 0, 0, 0, 0, 0]), null);
  const s = sessionCost({ '2026-10-04T01|claude-opus-5-5||': [M, 0, 0, 0, 0, 0], '2026-10-04T01|mystery||': [M, 0, 0, 0, 0, 0] });
  close(s.usd, 4);
  assert.deepEqual(s.unknownModels, ['mystery']);
});

const line = (o) => JSON.stringify({ sessionId: 's', cwd: '/home/dev/app', ...o });

test('利用量を1時間・モデル単位で集計し、確定前の usage は本文から見積もる', () => {
  const text = [
    line({ type: 'user', timestamp: '2026-10-04T01:00:00Z', message: { role: 'user', content: 'やって' } }),
    // 確定済み(stop_reason あり)。分割された行は最後の usage を採る
    line({ type: 'assistant', timestamp: '2026-10-04T01:00:05Z', message: { id: 'a', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } } } }),
    line({ type: 'assistant', timestamp: '2026-10-04T01:00:09Z', message: { id: 'a', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'y' }], usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } } } }),
    // 未確定(stop_reason なし)で 400 文字書いたのに output_tokens が 7
    line({ type: 'assistant', timestamp: '2026-10-04T02:10:00Z', message: { id: 'b', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'あ'.repeat(400) }], usage: { input_tokens: 5, output_tokens: 7, speed: 'fast', inference_geo: 'us' } } }),
    // API を呼んでいない応答は数えない
    line({ type: 'assistant', timestamp: '2026-10-04T02:11:00Z', message: { id: 'c', model: '<synthetic>', content: [], usage: { input_tokens: 0, output_tokens: 0 } } }),
  ].join('\n');
  const s = parseSessionText(text, { file: '/x/s.jsonl' });
  assert.deepEqual(s.usage, {
    '2026-10-04T01|claude-opus-5-5||': [10, 40, 100, 20, 30, 0],
    '2026-10-04T02|claude-sonnet-5-5|fast|us': [5, 200, 0, 0, 0, 0],
  });
  assert.equal(s.estimatedOutputTokens, 193);
  assert.equal(s.tokens.output, 240);
});

test('サブエージェントの利用量を親セッションのプロジェクトに合算し、期間で絞る', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-log-cost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', '-home-dev-app');
  await mkdir(path.join(proj, 'p1', 'subagents'), { recursive: true });
  const usage = (id, ts, model, input) =>
    line({ type: 'assistant', timestamp: ts, message: { id, model, stop_reason: 'end_turn', content: [], usage: { input_tokens: input, output_tokens: 0 } } });
  await writeFile(path.join(proj, 'p1.jsonl'), [
    line({ type: 'user', timestamp: '2026-10-04T01:00:00Z', message: { role: 'user', content: 'go' } }),
    usage('m1', '2026-10-04T01:00:01Z', 'claude-opus-5-5', M),
    usage('m2', '2026-10-06T01:00:01Z', 'claude-opus-5-5', M),
  ].join('\n'));
  await writeFile(path.join(proj, 'p1', 'subagents', 'agent-x.jsonl'), [
    line({ type: 'user', isSidechain: true, timestamp: '2026-10-04T01:01:00Z', message: { role: 'user', content: 'sub' } }),
    usage('s1', '2026-10-04T01:02:00Z', 'claude-sonnet-5-5', M),
  ].join('\n'));
  const store = new Store({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache') });
  await store.scan();

  const [s] = store.sessions();
  assert.equal(store.sessions().length, 1); // サブエージェントは独立したセッションとして出さない
  close(s.cost.usd, 4 + 4 + 2);
  close(s.cost.subagentUsd, 2);
  assert.equal(s.cost.subagents, 1);

  const c = store.costs({ from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z' });
  assert.deepEqual(c.buckets.map((b) => [b.model, b.project, b.usd]).sort(), [
    ['claude-opus-5-5', 'app', 4],
    ['claude-sonnet-5-5', 'app', 2],
  ]);
  assert.equal(c.topSessions[0].id, 'p1');
  close(c.topSessions[0].usd, 6);
  assert.equal(store.costs({ project: 'other' }).buckets.length, 0);
  assert.equal(c.estimated, false);
});
