/** Generated content only: block starts, empty deltas and usage are not tokens. */
export function hasGeneratedOutput(chunk) {
  const nonempty = value => typeof value === 'string' && value.length > 0
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return nonempty(chunk.text)
  if (chunk?.type === 'tool-call-delta') return nonempty(chunk.argumentsDelta)
  if (chunk?.type === 'block-end') {
    return nonempty(chunk.block?.text) || (chunk.block?.type === 'tool-call' && nonempty(chunk.block.arguments))
  }
  return false
}
