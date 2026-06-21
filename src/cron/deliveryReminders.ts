import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { sendTextToOwner } from '../services/whatsapp.js';

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://orderflow.ma/dashboard';

// Job 1 — Notif marchand: toutes les 15 min, orders EN_LIVRAISON dont estimatedDeliveryAt + 2h est dépassé
cron.schedule('*/15 * * * *', async () => {
  try {
    const threshold = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: {
        status: 'EN_LIVRAISON',
        confirmationResolved: false,
        estimatedDeliveryAt: { lte: threshold },
        merchantNotifiedAt: null,
      },
      include: { business: true },
    });

    for (const order of orders) {
      const montant = order.totalPrice ?? order.price ?? 0;
      const message =
        `📦 La commande de ${order.customerName} (${montant} DH) — livrée ? ` +
        `Mets à jour le statut 👉 ${DASHBOARD_URL}/orders/${order.id}`;

      await sendTextToOwner(order.business, message);
      await prisma.order.update({
        where: { id: order.id },
        data: { merchantNotifiedAt: new Date() },
      });

      console.log(`[NOTIF_MARCHAND] order ${order.id} — notif envoyée`);
    }
  } catch (err) {
    console.error('[NOTIF_MARCHAND] cron error:', err);
  }
});

// Job 2 — Escalade: toutes les 15 min, orders EN_LIVRAISON dont estimatedDeliveryAt + 26h est dépassé
cron.schedule('*/15 * * * *', async () => {
  try {
    const threshold = new Date(Date.now() - 26 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: {
        status: 'EN_LIVRAISON',
        confirmationResolved: false,
        estimatedDeliveryAt: { lte: threshold },
        escalationTriggeredAt: null,
      },
    });

    for (const order of orders) {
      await prisma.order.update({
        where: { id: order.id },
        data: { escalationTriggeredAt: new Date() },
      });
      console.log(`[ESCALADE] order ${order.id} — aucune MAJ marchand`);
    }
  } catch (err) {
    console.error('[ESCALADE] cron error:', err);
  }
});

export {};
