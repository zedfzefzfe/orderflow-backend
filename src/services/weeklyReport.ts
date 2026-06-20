import { prisma } from '../lib/prisma.js';
import { sendWeeklyReport } from './emailService.js';

export async function sendAllWeeklyReports(): Promise<void> {
  console.log('[WEEKLY] Starting weekly reports...');

  const businesses = await prisma.business.findMany({
    where: {
      email: { not: null },
      weeklyReportEnabled: true,
    },
  });

  console.log(`[WEEKLY] Found ${businesses.length} businesses to notify`);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const business of businesses) {
    try {
      const orders = await prisma.order.findMany({
        where: { businessId: business.id, createdAt: { gte: weekAgo } },
      });

      const totalOrders = orders.length;
      const confirmedOrders = orders.filter((o) => o.status === 'CONFIRMED').length;
      const deliveredOrders = orders.filter((o) => o.status === 'DELIVERED').length;
      const cancelledOrders = orders.filter((o) => o.status === 'CANCELLED').length;

      const caReel = orders
        .filter((o) => ['CONFIRMED', 'DELIVERED'].includes(o.status))
        .reduce((sum, o) => sum + (o.price ?? 0) * (o.quantity ?? 1), 0);

      const caEstime = orders.reduce(
        (sum, o) => sum + (o.price ?? 0) * (o.quantity ?? 1) + (o.deliveryPrice ?? 0),
        0,
      );

      const confirmationRate =
        totalOrders > 0 ? Math.round(((confirmedOrders + deliveredOrders) / totalOrders) * 100) : 0;

      const returnRate =
        totalOrders > 0 ? Math.round((cancelledOrders / totalOrders) * 100) : 0;

      const productCounts = orders.reduce<Record<string, number>>((acc, o) => {
        if (o.product) acc[o.product] = (acc[o.product] ?? 0) + 1;
        return acc;
      }, {});
      const topProduct =
        Object.entries(productCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N/A';

      const cityCounts = orders.reduce<Record<string, number>>((acc, o) => {
        if (o.address) acc[o.address] = (acc[o.address] ?? 0) + 1;
        return acc;
      }, {});
      const topCity =
        Object.entries(cityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N/A';

      await sendWeeklyReport(business.email!, business.name || 'Marchand', {
        totalOrders,
        confirmedOrders,
        deliveredOrders,
        cancelledOrders,
        caReel: Math.round(caReel),
        caEstime: Math.round(caEstime),
        confirmationRate,
        returnRate,
        topProduct,
        topCity,
      });
    } catch (err) {
      console.error('[WEEKLY] Failed for business:', business.id, err);
    }
  }

  console.log('[WEEKLY] All reports sent!');
}
