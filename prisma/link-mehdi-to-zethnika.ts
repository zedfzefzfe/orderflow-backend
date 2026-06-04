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
  const zethnika = await prisma.business.findFirst({
    where: { whatsappPhoneNumberId: '1055196677688218' },
  });

  if (!zethnika) {
    console.error('ERROR: Zethnika business not found (whatsappPhoneNumberId=1055196677688218)');
    process.exit(1);
  }

  console.log(`Zethnika business found: id=${zethnika.id} name="${zethnika.name}"`);

  const user = await prisma.user.findFirst({
    where: { email: 'mehdi@gmail.com' },
  });

  if (!user) {
    console.error('ERROR: User mehdi@gmail.com not found in users table');
    process.exit(1);
  }

  console.log(`\nBEFORE: user ${user.email} → businessId=${user.businessId}`);

  if (user.businessId === zethnika.id) {
    console.log('Already linked to Zethnika — nothing to do.');
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { businessId: zethnika.id },
  });

  console.log(`AFTER:  user ${updated.email} → businessId=${updated.businessId}`);
  console.log('\nSuccess: mehdi@gmail.com is now linked to Zethnika.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
