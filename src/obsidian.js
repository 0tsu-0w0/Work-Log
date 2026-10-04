// Obsidian の Vault に Markdown のノートとして保存する。ネットワークは使わず、Vault のフォルダに直接書く。
//   日報・週報: <フォルダ>/2026-10-04 日報.md / 2026-W40 週報.md(同じ期間を送り直すと、そのノートを上書きする。一時ファイルに書いてから置き換える)
//   セッション終了の通知: <フォルダ>/2026-10-04 セッション.md の末尾に1行足す
// Vault は OBSIDIAN_VAULT_DIR(または config.json の obsidian.vault)、フォルダは config.json の obsidian.folder(既定 "Work Log")。
// 安全のため、フォルダに ".." や絶対パス、"." で始まる名前(.obsidian など)は使えず、
// 書き込み先は(シンボリックリンクをたどった後も)Vault の中でなければ書かない。ファイル名は期間の日付だけから作り、本文の内容は使わない。
// 返す url は obsidian://open?vault=<Vault の名前(フォルダ名)>&file=<ノートのパス> (Obsidian の URI の形。実際に開けるかは Obsidian での確認が必要)。
import { mkdir, writeFile, appendFile, rename, realpath, lstat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteName } from './docreport.js';

const DEFAULT_FOLDER = 'Work Log';

export class Obsidian {
  constructor({ env = process.env, config = {} } = {}) {
    this.env = env;
    this.setConfig(config);
  }

  setConfig(cfg = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
  }

  // 絶対パスの、存在するフォルダだけ(~/ は自分のホームに置き換える)
  vault() {
    let v = String(this.env.OBSIDIAN_VAULT_DIR || this.cfg.vault || '').trim();
    if (v === '~' || v.startsWith('~/')) v = path.join(os.homedir(), v.slice(1));
    if (!v || !path.isAbsolute(v)) return null;
    try {
      return statSync(v).isDirectory() ? path.resolve(v) : null;
    } catch {
      return null;
    }
  }

  // Vault からの相対のフォルダ("a/b")。".." を含む・絶対パス・"." で始まる名前・制御文字や \ を含むものは不可
  folder() {
    const raw = this.cfg.folder == null || this.cfg.folder === '' ? DEFAULT_FOLDER : this.cfg.folder;
    if (typeof raw !== 'string' || raw.includes('..') || /[\\\0-\x1f:*?"<>|]/.test(raw) || raw.startsWith('/')) return null;
    const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
    if (!parts.length || parts.some((p) => p.startsWith('.'))) return null;
    return parts.join('/');
  }

  status() {
    const v = this.vault();
    const f = this.folder();
    const ok = Boolean(v && f);
    return {
      configured: ok,
      mode: ok ? 'file' : null,
      destination: ok ? `${path.basename(v)}/${f}` : null,
      includeCost: Boolean(this.cfg.includeCost),
      notify: this.cfg.notify === 'session_end' ? 'session_end' : null,
    };
  }

  // 書き込み先のフォルダを作って、Vault の外に出ていないことを確かめる(まだ無い部分は、あるところまでさかのぼって確かめる)
  async ensureDir(vault, folder) {
    const realVault = await realpath(vault);
    const inside = (p) => p === realVault || p.startsWith(realVault + path.sep);
    let probe = path.join(vault, folder);
    for (;;) {
      try {
        await lstat(probe);
        break;
      } catch {
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
    }
    if (!inside(await realpath(probe))) throw new Error('Obsidian: 書き込み先が Vault の外になるため書きません');
    const dir = path.join(vault, folder);
    await mkdir(dir, { recursive: true });
    if (!inside(await realpath(dir))) throw new Error('Obsidian: 書き込み先が Vault の外になるため書きません');
    return dir;
  }

  uri(vault, folder, file) {
    return `obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=${encodeURIComponent(`${folder}/${file.replace(/\.md$/, '')}`)}`;
  }

  async post(message) {
    const vault = this.vault();
    const folder = this.folder();
    if (!vault) throw new Error('Obsidian の Vault が設定されていません(OBSIDIAN_VAULT_DIR に、存在するフォルダの絶対パスを指定してください)');
    if (!folder) throw new Error('Obsidian のフォルダの指定が正しくありません(obsidian.folder に、".." を含まない Vault 内の相対パスを指定してください)');

    if (message?.kind === 'session') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(message.date || '') || typeof message.line !== 'string') throw new Error('Obsidian: セッション終了の通知の形が正しくありません');
      const file = `${message.date} セッション.md`;
      const dir = await this.ensureDir(vault, folder);
      const target = path.join(dir, file);
      const line = `${message.line.replace(/\r?\n/g, ' ')}\n`;
      const st = await lstat(target).catch(() => null);
      if (st && !st.isFile()) throw new Error('Obsidian: 同じ名前のファイル以外のものがあるため書きません');
      try {
        // 無ければプロパティ付きで作る(あれば末尾に足す)
        await writeFile(target, `---\ndate: ${message.date}\ntags: [work-log]\n---\n\n${line}`, { flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        await appendFile(target, line);
      }
      return { url: this.uri(vault, folder, file) };
    }

    if (message?.kind !== 'report' || !['day', 'week'].includes(message.period) || !/^\d{4}-\d{2}-\d{2}$/.test(message.start || '') || typeof message.body !== 'string') {
      throw new Error('Obsidian に送れるのは日報・週報だけです');
    }
    const file = noteName(message.period, message.start);
    const dir = await this.ensureDir(vault, folder);
    const target = path.join(dir, file);
    // ノートの場所にフォルダやシンボリックリンクがあるときは置き換えない
    const st = await lstat(target).catch(() => null);
    if (st && !st.isFile()) throw new Error('Obsidian: 同じ名前のファイル以外のものがあるため書きません');
    const tmp = path.join(dir, `.${file}.${process.pid}.tmp`);
    await writeFile(tmp, message.body);
    await rename(tmp, target);
    return { url: this.uri(vault, folder, file), updated: Boolean(st) };
  }
}
