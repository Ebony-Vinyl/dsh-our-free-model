/** Historical compatibility markers and wire defaults; see SYNC.md.
 * These markers identify the pre-rewrite reference, not the current implementation.
 * @module src/o2a/version.js
 */
export const O2A_VERSION = '1.4.7'
export const O2A_COMMIT = 'b296a61d0e3ef93b4df58e298be2c4e34e397322'
export const O2A_REFERENCE = 'https://github.com/jasonxu114514/opencode2api'

// Preserve the existing gateway wire contract while replacing local implementation.
export const V2_CLIENT_VERSION = '2.2.3'
export const CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`
export const V2_COMPLETION_LIMIT = 32000
export const ANONYMOUS_CREDENTIAL = 'public'
