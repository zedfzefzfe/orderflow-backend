import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clean up existing data (for dev re-runs)
  await prisma.order.deleteMany();
  await prisma.messageLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.business.deleteMany();

  // Create Zethnika candle business
  const business = await prisma.business.create({
    data: {
      name: 'Zethnika',
      whatsappPhoneNumberId: 'YOUR_PHONE_NUMBER_ID', // Replace with real ID from Meta
      ownerNotifyPhone: '212600000000', // Replace with owner's real WhatsApp
    },
  });

  console.log(`Created business: ${business.name} (${business.id})`);

  // Create owner user
  const bcrypt = await import('bcryptjs');
  const hashedPassword = await bcrypt.hash('zethnika123', 10);

  const user = await prisma.user.create({
    data: {
      email: 'owner@zethnika.ma',
      password: hashedPassword,
      businessId: business.id,
      role: 'owner',
    },
  });

  console.log(`Created user: ${user.email} / password: zethnika123`);

  // Create some sample orders
  const sampleOrders = [
    {
      businessId: business.id,
      customerName: 'Fatima Zahra',
      customerPhone: '212612345678',
      product: 'Bougie vanille + parfum rose',
      quantity: 2,
      address: 'Rabat, Agdal',
      deliveryDate: '2026-06-02',
      totalPrice: 350,
      status: 'NEW' as const,
      rawMessage: 'salam bghit 2 bougies vanille w parfum rose livraison Rabat Agdal',
      source: 'whatsapp',
    },
    {
      businessId: business.id,
      customerName: 'Youssef Alami',
      customerPhone: '612998877',
      product: 'Coffret bougies luxe',
      quantity: 1,
      address: 'Casablanca, Maarif',
      totalPrice: 500,
      status: 'CONFIRMED' as const,
      rawMessage: 'Bonjour je voudrais commander un coffret bougies luxe livraison Casablanca Maarif',
      source: 'whatsapp',
    },
    {
      businessId: business.id,
      customerName: 'Amina Bennani',
      customerPhone: '212634561234',
      product: '3 bougies parfumées',
      quantity: 3,
      address: 'Marrakech, Gueliz',
      deliveryDate: '2026-06-05',
      totalPrice: 450,
      status: 'DELIVERED' as const,
      rawMessage: 'Salam 3 dyal lbougie parfume livraison Marrakech Gueliz',
      source: 'whatsapp',
    },
    {
      businessId: business.id,
      customerName: 'Karim Fassi',
      customerPhone: '212645782233',
      product: 'Bougie bois de oud',
      quantity: 2,
      address: 'Fes, Ville nouvelle',
      status: 'NEW' as const,
      rawMessage: 'bnjr bghit juj dyal lbougie oud fes',
      source: 'whatsapp',
    },
  ];

  for (const orderData of sampleOrders) {
    const order = await prisma.order.create({ data: orderData });
    console.log(`Created order: ${order.id} - ${order.customerName} (${order.status})`);
  }

  console.log('\nSeed complete! Login with:');
  console.log('  Email: owner@zethnika.ma');
  console.log('  Password: zethnika123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
