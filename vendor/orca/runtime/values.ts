// Extracted unchanged from Orca; see ../manifest.json and ../LICENSE.
export { asRecord } from './session-scanner-record-value.js'

export function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

