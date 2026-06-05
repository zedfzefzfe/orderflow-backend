import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const OLD_PHONE_ID = '1055196677688218';
const NEW_PHONE_ID = '1133080406561594';
const NEW_ACCOUNT_ID = '2231503007585613';

async function main() {
  const before = await prisma.business.findFirst({
    where: { whatsappPhoneNumberId: OLD_PHONE_ID },
  });

  if (!before) {
    console.error(`ERROR: No business found with whatsappPhoneNumberId=${OLD_PHONE_ID}`);
    process.exit(1);
  }

  console.log('BEFORE:', JSON.stringify({
    id: before.id,
    name: before.name,
    whatsappPhoneNumberId: before.whatsappPhoneNumberId,
    whatsappBusinessAccountId: before.whatsappBusinessAccountId,
  }, null, 2));

  const updated = await prisma.business.update({
    where: { id: before.id },
    data: {
      whatsappPhoneNumberId: NEW_PHONE_ID,
      whatsappBusinessAccountId: NEW_ACCOUNT_ID,
    },
  });

  console.log('\nAFTER:', JSON.stringify({
    id: updated.id,
    name: updated.name,
    whatsappPhoneNumberId: updated.whatsappPhoneNumberId,
    whatsappBusinessAccountId: updated.whatsappBusinessAccountId,
  }, null, 2));

  console.log('\nSuccess: Zethnika phone number IDs updated.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
