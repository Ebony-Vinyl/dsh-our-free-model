/** A failed external-output transform leaves the request's original text intact. */
export function safeApply(filter, text) {
  if (typeof filter !== 'function') return text
  try {
    const result = filter(text)
    return typeof result === 'string' ? result : text
  } catch (error) {
    console.warn(`[rtk] warning: filter '${filter.filterName || filter.name || 'anonymous'}' panicked — passing through raw output: ${error?.message || error}`)
    return text
  }
}
