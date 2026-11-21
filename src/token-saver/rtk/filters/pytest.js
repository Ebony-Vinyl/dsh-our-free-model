/**
 * Collapse pytest output to its verdict and the failure detail a model acts on.
 * @module src/token-saver/rtk/filters/pytest.js
 */

const SUMMARY = /^[=\s]*(\d+\s+(?:passed|failed|error|errors|skipped|xfailed|xpassed)[^=\n]*?\bin\s+[\d.]+s)[=\s]*$/im
const LOOSE = /(\d+\s+(?:passed|failed|error|errors|skipped)[^\n]*?in\s+[\d.]+s)/i
const KEEP = /^(?:FAILED|ERROR)\b|^E\s+|^_{3,}\s|^=+\s*FAILURES\s*=+|^File "|^assert\b|^>\s+/

export function pytest(input) {
  const summary = (SUMMARY.exec(input)?.[1] ?? LOOSE.exec(input)?.[1])?.trim()
  const failed = /\b(?:failed|error|errors)\b/i.test(summary ?? '') || /^(?:FAILED|ERROR)\b/m.test(input)
  if (!failed) return summary ? `✓ ${summary}` : input
  const kept = input.split('\n').filter((line) => KEEP.test(line.trim()) || (summary !== undefined && line.includes(summary)))
  const body = kept.slice(0, 120).join('\n')
  const out = `${summary === undefined ? '' : `✗ ${summary}\n`}${body}`.trim()
  return out || input
}

pytest.filterName = 'pytest'
