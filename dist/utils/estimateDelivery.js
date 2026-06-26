import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
dayjs.extend(customParseFormat);
// Accepted date formats for the free-text deliveryDate field
const DATE_FORMATS = [
    'DD/MM/YYYY',
    'D/M/YYYY',
    'YYYY-MM-DD',
    'DD-MM-YYYY',
    'D MMM YYYY',
    'DD MMM YYYY',
];
export function estimateDeliveryAt(order) {
    if (order.deliveryDate) {
        for (const fmt of DATE_FORMATS) {
            const parsed = dayjs(order.deliveryDate, fmt, true);
            if (parsed.isValid()) {
                return parsed.toDate();
            }
        }
        // Try native parse as last resort
        const native = new Date(order.deliveryDate);
        if (!isNaN(native.getTime()))
            return native;
    }
    // No wilaya fields on Order v1 — universal J+2 fallback
    const d = new Date();
    d.setDate(d.getDate() + 2);
    d.setHours(18, 0, 0, 0);
    return d;
}
//# sourceMappingURL=estimateDelivery.js.map