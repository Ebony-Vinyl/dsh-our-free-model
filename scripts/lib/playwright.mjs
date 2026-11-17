/**
 * Load Playwright when the machine has it, or return null.
 *
 * The offline suite runs in CI images that do not install Playwright. A browser
 * test should skip there instead of failing the whole suite with
 * MODULE_NOT_FOUND. OFM_PLAYWRIGHT_MODULE still wins for a custom install.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)

export function loadPlaywright() {
  for (const candidate of [
    process.env.OFM_PLAYWRIGHT_MODULE,
    'playwright',
    'playwright-core',
  ].filter(Boolean)) {
    try {
      return require(candidate)
    } catch { /* try the next candidate */ }
  }
  try {
    return require(require.resolve('playwright', {
      paths: [root, process.env.CODEX_MCP_NODE_PATH].filter(Boolean),
    }))
  } catch {
    return null
  }
}

/**
 * The Chromium handle, or null when either the module or its browser binary is
 * absent. CI installs neither; a local checkout may have the module without
 * running `playwright install`.
 */
export function loadChromium() {
  const playwright = loadPlaywright()
  if (playwright === null) return null
  try {
    if (!fs.existsSync(playwright.chromium.executablePath())) return null
  } catch {
    return null
  }
  return playwright.chromium
}
