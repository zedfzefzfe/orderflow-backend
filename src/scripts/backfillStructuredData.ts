import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { extractStructuredFields } from '../services/llmParser.js';
import { recomputeCustomer } from '../services/customerScoring.js';
import type { ProductCategory, MoroccanWilaya, DeliveryCompany } from '@prisma/client';

const BATCH_SIZE = 20;
const CONCURRENCY = 5;

async function processOrder(order: {
  id: string;
  product: string;
  address: string | null;
  rawMessage: string;
}): Promise<{ updated: boolean; error?: string }> {
  try {
    const fields = await extractStructuredFields(order.product, order.address, order.rawMessage);
    const data: Record<string, unknown> = {};
    if (fields.productCategory) data.productCategory = fields.productCategory as ProductCategory;
    if (fields.wilaya)          data.wilaya          = fields.wilaya as MoroccanWilaya;
    if (fields.city)            data.city            = fields.city;
    if (fields.deliveryCompany) data.deliveryCompany = fields.deliveryCompany as DeliveryCompany;
    if (Object.keys(data).length === 0) return { updated: false };
    await prisma.order.update({ where: { id: order.id }, data });
    return { updated: true };
  } catch (err) {
    return { updated: false, error: String(err) };
  }
}

async function main() {
  // ── Étape 1 : re-parser les commandes sans productCategory ────────────────────
  const orders = await prisma.order.findMany({
    where: { productCategory: null },
    select: { id: true, product: true, address: true, rawMessage: true, customerPhone: true, businessId: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n[backfill] ${orders.length} commandes sans productCategory trouvées.\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const totalBatches = Math.ceil(orders.length / BATCH_SIZE);

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} commandes)... `);

    // Traitement en sous-batches de CONCURRENCY pour éviter le rate limiting
    for (let j = 0; j < batch.length; j += CONCURRENCY) {
      const sub = batch.slice(j, j + CONCURRENCY);
      const results = await Promise.allSettled(sub.map(processOrder));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.updated) updated++;
          else if (r.value.error) { errors++; console.error('\n    Erreur:', r.value.error); }
          else skipped++;
        } else {
          errors++;
        }
      }
    }
    console.log('✓');
  }

  console.log(`\n[backfill] Commandes: ${updated} mises à jour, ${skipped} sans champ extrait, ${errors} erreurs.`);

  // ── Étape 2 : recomputer les customers pour wilaya/city/firstOrderAt/avgOrderValue ──
  const uniqueCustomers = [
    ...new Map(
      orders.map((o) => [`${o.customerPhone}|${o.businessId}`, o] as const)
    ).values(),
  ];

  console.log(`\n[backfill] Recompute de ${uniqueCustomers.length} customers pour wilaya/city/avgOrderValue...`);

  let custUpdated = 0;
  let custErrors = 0;

  for (let i = 0; i < uniqueCustomers.length; i += CONCURRENCY) {
    const sub = uniqueCustomers.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      sub.map(async (c) => {
        try {
          await recomputeCustomer(c.customerPhone, c.businessId);
          custUpdated++;
        } catch (err) {
          custErrors++;
          console.error(`  Erreur recompute ${c.customerPhone}:`, err);
        }
      }),
    );
  }

  console.log(`[backfill] Customers: ${custUpdated} recomputed, ${custErrors} erreurs.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
