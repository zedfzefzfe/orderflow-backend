export function normalizePhone(raw) {
    // Strip spaces, dashes, parentheses, dots
    const cleaned = raw.replace(/[\s\-().]/g, '');
    if (!cleaned)
        return raw.trim();
    // Already E.164 +212XXXXXXXXX
    if (cleaned.startsWith('+212'))
        return cleaned;
    // 212XXXXXXXXX (12 chars) → +212XXXXXXXXX
    if (cleaned.startsWith('212') && cleaned.length === 12)
        return '+' + cleaned;
    // 0XXXXXXXXX (10 chars) → +212XXXXXXXXX
    if (cleaned.startsWith('0') && cleaned.length === 10)
        return '+212' + cleaned.slice(1);
    // 6XXXXXXXX or 7XXXXXXXX (9 chars) → +212XXXXXXXXX
    if ((cleaned.startsWith('6') || cleaned.startsWith('7')) && cleaned.length === 9)
        return '+212' + cleaned;
    // Unrecognised format — return cleaned value, never crash
    return cleaned;
}
//# sourceMappingURL=normalizePhone.js.map