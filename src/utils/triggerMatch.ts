// Shared trigger normalization.
//
// Used by both the inbound webhook (to match a customer's message against a
// configured trigger) and the automations API (to validate a trigger before it
// is saved). Both sides MUST use this exact function — if they ever diverge, a
// trigger accepted by the API could become unmatchable by the webhook.

// Strips accents, punctuation, and case so encoding differences between iOS /
// Android / WhatsApp versions don't break trigger detection.
export function stripForMatch(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')                              // strip combining accents
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27FF}]|[︀-️]/gu, '') // strip emojis
    .replace(/[^a-z0-9 ]/gi, '')                                  // strip remaining non-alphanumeric
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
