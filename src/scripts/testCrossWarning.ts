import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { getGlobalClientRisk } from '../services/customerScoring.js';

const FAKE_BUSINESS_ID = 'test-business-fake';

async function main() {
  // 1. Récupère le client MAUVAIS
  const mauvais = await prisma.customer.findFirst({
    where: { riskLevel: 'MAUVAIS' },
    select: { phone: true, businessId: true, clientFaultReturns: true, riskScore: true },
  });

  if (!mauvais) {
    console.log('Aucun client MAUVAIS trouvé en DB. Lance le backfill d\'abord.');
    return;
  }

  console.log('Client MAUVAIS trouvé :', mauvais);

  // 2. Crée un faux business pour satisfaire la FK, puis insère le customer fictif
  const fakeBiz = await prisma.business.create({
    data: { id: FAKE_BUSINESS_ID, name: '[TEST] Fake Business' },
  });
  console.log('\nFaux business créé :', fakeBiz.id);

  const fakeCustomerId = `test-fake-${Date.now()}`;
  const fake = await prisma.customer.create({
    data: {
      id: fakeCustomerId,
      phone: mauvais.phone,
      businessId: FAKE_BUSINESS_ID,
      names: ['Test Fictif'],
      totalOrders: 3,
      delivered: 1,
      clientFaultReturns: 2,
      reporteClient: 0,
      legitReturns: 0,
      faultPoints: 2,
      riskScore: 67,
      riskLevel: 'MAUVAIS',
    },
  });
  console.log('Ligne fictive insérée :', { id: fake.id, phone: fake.phone, businessId: fake.businessId });

  // 3. Appelle getGlobalClientRisk et log le résultat
  console.log('\n--- getGlobalClientRisk ---');
  const result = await getGlobalClientRisk(mauvais.phone);
  console.log(JSON.stringify(result, null, 2));

  // 4. Cleanup — supprime customer fictif puis business fictif
  await prisma.customer.delete({ where: { id: fake.id } });
  await prisma.business.delete({ where: { id: FAKE_BUSINESS_ID } });
  console.log('\nCleanup OK (customer + business fictifs supprimés).');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
