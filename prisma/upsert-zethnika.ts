import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  const PHONE_NUMBER_ID = '1055196677688218';
  const BUSINESS_ACCOUNT_ID = '1462677828994929';

  // Find by phoneNumberId first, then by name — handles any existing record
  let existing = await prisma.business.findFirst({
    where: { whatsappPhoneNumberId: PHONE_NUMBER_ID },
  });

  if (!existing) {
    existing = await prisma.business.findFirst({
      where: { name: 'Zethnika' },
    });
  }

  let business;

  if (existing) {
    business = await prisma.business.update({
      where: { id: existing.id },
      data: {
        name: 'Zethnika',
        whatsappPhoneNumberId: PHONE_NUMBER_ID,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_ID,
      },
    });
    console.log('Updated existing business record.');
  } else {
    business = await prisma.business.create({
      data: {
        name: 'Zethnika',
        whatsappPhoneNumberId: PHONE_NUMBER_ID,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_ID,
      },
    });
    console.log('Created new business record.');
  }

  console.log('\nBusiness record in DB:');
  console.log(JSON.stringify(business, null, 2));

  // Also show all business records so we can confirm state
  const all = await prisma.business.findMany();
  console.log(`\nTotal business records in DB: ${all.length}`);
  for (const b of all) {
    console.log(`  - ${b.id} | name="${b.name}" | phoneNumberId=${b.whatsappPhoneNumberId} | accountId=${b.whatsappBusinessAccountId}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
