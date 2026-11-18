/** Authored OFM style directives; level names remain compatible with saved settings. */
export const CAVEMAN_LEVELS = ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-ultra']
export const PONYTAIL_LEVELS = ['off', 'lite', 'full', 'ultra']

const answerBoundary = 'Keep code, identifiers, paths, commands, error text and URLs unchanged. Use complete, clear language for security guidance, irreversible decisions and ordered procedures; clarity takes priority over brevity. Do not invent abbreviations. Follow the user\'s language except when a classical Chinese level is selected. Do not announce this style or add decorative emoji. Apply the selected level throughout the conversation while respecting explicit user instructions.'
const answerLevels = new Map([
  ['lite', 'Use short grammatical sentences. Remove filler while retaining the explanation needed to act.'],
  ['full', 'Prefer compact phrases and direct conclusions. Keep technical detail and necessary reasoning.'],
  ['ultra', 'Give the smallest unambiguous answer that satisfies the request. Omit repetition, never required facts.'],
  ['wenyan-lite', 'Use readable Chinese with a light classical register and short sentences.'],
  ['wenyan', 'Use concise classical Chinese for prose; keep technical material precise and readily understandable.'],
  ['wenyan-ultra', 'Use very brief classical Chinese prose. Expand whenever compression would make an action ambiguous.'],
].map(([level, text]) => [level, `${text} ${answerBoundary}`]))

const codeBoundary = 'Implement only the requested behavior. Reuse existing project code, standard libraries and installed dependencies before adding code. Keep responsibility in the relevant module. Avoid speculative abstractions, options and future scaffolding. Preserve validation at trust boundaries, data-loss prevention, security, accessibility and explicit requirements. Verify meaningful behavior with a focused runnable check; trivial changes need no artificial test. Explain material limitations without claiming unperformed verification. Continue this discipline across turns.'
const codeLevels = new Map([
  ['lite', 'Make the requested change with minimal additions; mention a simpler alternative only when useful.'],
  ['full', 'Choose the smallest maintainable implementation and keep the diff focused on the requested capability.'],
  ['ultra', 'Actively remove unnecessary work and duplication before adding code; preserve every required behavior.'],
].map(([level, text]) => [level, `${text} ${codeBoundary}`]))

export function cavemanPrompt(level) {
  return answerLevels.get(level) ?? null
}
export function ponytailPrompt(level) {
  return codeLevels.get(level) ?? null
}
export function activePrompts({ caveman, ponytail } = {}) {
  const result = []
  for (const [id, level, lookup] of [['caveman', caveman, cavemanPrompt], ['ponytail', ponytail, ponytailPrompt]]) {
    const text = lookup(level)
    if (text !== null) result.push({ id, level, text })
  }
  return result
}
