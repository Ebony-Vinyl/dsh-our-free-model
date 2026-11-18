/** Read authored OFM assets once; missing packaged assets are build failures. */
import { readFileSync } from 'node:fs'

let prompt, tools
export function officialPromptText() {
  return prompt ??= readFileSync(new URL('./assets/ofm-agent-context.txt', import.meta.url), 'utf8')
}
export function officialToolsText() {
  return tools ??= readFileSync(new URL('./assets/ofm-tool-contracts.json', import.meta.url), 'utf8')
}
