/** 与 Docker --timestamps 常见前缀一致（行首 ISO 时间） */
const LINE_TS_PREFIX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}(?::\d{2})?))/;

/**
 * Jupyter Server / Hub 常见：`... | [I 2026-04-02 03:43:09.339 ServerApp] ...`
 * （无 `docker service logs --timestamps` 时行首常是 task 名而非 ISO）
 */
const JUPYTER_LOG_BRACKET = /\[([IWEC])\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/;

/**
 * Docker CLI 常把 `docker service logs` 的日志写到 stderr，stdout 为空。
 * 合并 stdout/stderr 全部非空行；不再按「行首 ISO」子集过滤，避免丢掉
 * `jupyter-....@node | [I 2026-04-02 ...]` 这类与 ISO 行混排时的记录。
 */
export function mergeDockerCliLogStreams(stdout: string, stderr: string): string[] {
  const merged = [...stdout.split('\n'), ...stderr.split('\n')]
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);
  return [...new Set(merged)];
}

export function parseDockerServiceLogLineTimeMs(line: string): number {
  const isoHead = line.match(LINE_TS_PREFIX);
  if (isoHead) {
    const t = Date.parse(isoHead[1]);
    if (Number.isFinite(t)) return t;
  }
  const jpy = line.match(JUPYTER_LOG_BRACKET);
  if (jpy) {
    const t = Date.parse(`${jpy[2]}T${jpy[3]}`);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

export function sortLogLinesAscending(lines: string[]): string[] {
  return [...lines].sort((a, b) => {
    const ta = parseDockerServiceLogLineTimeMs(a);
    const tb = parseDockerServiceLogLineTimeMs(b);
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });
}

/** 供下一页 --until：略早于当前批次最早一行 */
export function isoUntilBeforeLine(line: string): string | null {
  const ms = parseDockerServiceLogLineTimeMs(line);
  if (!ms) return null;
  return new Date(ms - 1).toISOString();
}
