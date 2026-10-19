/**
 * Upstream status → pool failure classification.
 *
 * OpenCode Go answers 429 both for "rate limited, retry shortly" and for
 * "quota exhausted", and the body is the only distinguishing signal.
 */

const QUOTA_HINTS = [
  'quota',
  'insufficient_quota',
  'usage limit',
  'usage_limit',
  'limit reached',
  'exceeded your',
  'out of credits',
  'credit balance',
  'balance',
  'billing',
  'subscription',
  'expired plan',
  'no remaining',
]

const RATE_HINTS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'slow down',
  'try again',
  'temporarily',
]

export const QUOTA_CODE = 'QUOTA'
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const RATE_LIMIT_CODE = 'RATE_LIMIT'
export const SERVER_CODE = 'SERVER'
export const TRANSPORT_CODE = 'TRANSPORT'
export const REGION_CODE = 'REGION'

const REGION_HINTS = [
  'unsupported_country_region_territory',
  'country, region, or territory not supported',
  'not available in your region',
  'not available in your country',
  'region not supported',
  'regionerror',
]

/**
 * @param {number} status
 * @param {string} body
 * @returns {string|null} a pool failure code, or null to pass the response through.
 */
export function classifyResponse(status, body = '') {
  const text = String(body || '').toLowerCase()
  // A model being unavailable in this country is a property of the MODEL, not
  // of the account: rotating keys cannot fix it and must not invalidate them.
  if (REGION_HINTS.some(hint => text.includes(hint))) return REGION_CODE
  if (status === 401 || status === 403) return INVALID_CREDENTIAL_CODE
  if (status === 402) return QUOTA_CODE
  if (status === 429) {
    if (QUOTA_HINTS.some(hint => text.includes(hint))) return QUOTA_CODE
    if (RATE_HINTS.some(hint => text.includes(hint))) return RATE_LIMIT_CODE
    // A bare 429 with no recognizable body is treated as quota pressure:
    // rotating to another account is the whole point of the pool.
    return QUOTA_CODE
  }
  if (status >= 500) return SERVER_CODE
  return null
}

/** Network-level failure (fetch rejected). */
export function classifyNetworkError() {
  return TRANSPORT_CODE
}

/** One-line human explanation for a classified failure. */
export function describeFailure(code) {
  switch (code) {
    case QUOTA_CODE: return '额度耗尽'
    case INVALID_CREDENTIAL_CODE: return 'Key 失效'
    case RATE_LIMIT_CODE: return '触发限流'
    case SERVER_CODE: return '上游 5xx'
    case TRANSPORT_CODE: return '网络错误'
    case REGION_CODE: return '当前地区不支持该模型'
    default: return String(code || '未知错误')
  }
}
