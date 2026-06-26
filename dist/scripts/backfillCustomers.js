import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { normalizePhone } from '../utils/normalizePhone.js';
import { recomputeCustomer } from '../services/customerScoring.js';
async function main() {
    console.log('[backfill] Scanning terminal orders...');
    // All distinct (customerPhone, businessId) pairs across terminal orders
    const pairs = await prisma.order.groupBy({
        by: ['customerPhone', 'businessId'],
        where: {
            status: { in: ['LIVRE', 'DELIVERED', 'RETOURNE', 'ANNULE', 'CANCELLED'] },
        },
    });
    // Deduplicate by normalized phone — different raw formats for the same number
    // collapse to one entry so we don't upsert twice unnecessarily
    const seen = new Set();
    const deduped = [];
    for (const p of pairs) {
        const key = `${normalizePhone(p.customerPhone)}|${p.businessId}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(p);
        }
    }
    console.log(`[backfill] ${deduped.length} unique customer/business pairs to process`);
    let ok = 0;
    let errors = 0;
    for (const { customerPhone, businessId } of deduped) {
        try {
            await recomputeCustomer(customerPhone, businessId);
            ok++;
            if (ok % 50 === 0)
                console.log(`[backfill]   ${ok}/${deduped.length}...`);
        }
        catch (err) {
            errors++;
            console.error(`[backfill] Error for ${customerPhone} / ${businessId}:`, err);
        }
    }
    console.log(`[backfill] Done. ${ok} customers created/updated, ${errors} errors.`);
}
main()
    .then(() => process.exit(0))
    .catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=backfillCustomers.js.map