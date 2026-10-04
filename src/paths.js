// ログとキャッシュの場所。フックからも読むので、依存を持たせない
import path from 'node:path';
import os from 'node:os';

export function defaultPaths(env = process.env) {
  const home = os.homedir();
  return {
    projectsDir: env.WORKLOG_PROJECTS_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
    cacheDir: env.WORKLOG_CACHE_DIR || path.join(home, '.work-log'),
    // Codex CLI のログ。CODEX_HOME(既定 ~/.codex)の sessions / archived_sessions
    codexDir: env.WORKLOG_CODEX_DIR || env.CODEX_HOME || path.join(home, '.codex'),
  };
}
