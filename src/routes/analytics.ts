import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/analytics/summary
router.get('/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const now = new Date();

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      totalAllTime,
      totalThisMonth,
      totalToday,
      revenueAgg,
      confirmedCount,
      confirmedDeliveredCount,
    ] = await Promise.all([
      prisma.order.count({ where: { businessId } }),
      prisma.order.count({ where: { businessId, createdAt: { gte: monthStart } } }),
      prisma.order.count({ where: { businessId, createdAt: { gte: todayStart } } }),
      prisma.order.aggregate({
        where: { businessId, createdAt: { gte: monthStart }, totalPrice: { not: null } },
        _sum: { totalPrice: true },
      }),
      prisma.order.count({
        where: { businessId, status: { in: ['CONFIRMED', 'DELIVERED'] }, createdAt: { gte: monthStart }, totalPrice: { not: null } },
      }),
      prisma.order.count({
        where: { businessId, status: { in: ['CONFIRMED', 'DELIVERED'] } },
      }),
    ]);

    const estimatedRevenue = revenueAgg._sum.totalPrice ?? 0;
    const confirmationRate = totalAllTime > 0
      ? Math.round((confirmedDeliveredCount / totalAllTime) * 100)
      : 0;
    const averageOrderValue = confirmedCount > 0
      ? Math.round(estimatedRevenue / confirmedCount)
      : 0;

    res.json({
      totalOrdersThisMonth: totalThisMonth,
      totalOrdersToday: totalToday,
      estimatedRevenue,
      confirmationRate,
      totalOrdersAllTime: totalAllTime,
      averageOrderValue,
    });
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/analytics/orders-by-day — last 30 days
router.get('/orders-by-day', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const orders = await prisma.order.findMany({
      where: { businessId, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    });

    const countByDay: Record<string, number> = {};
    for (const o of orders) {
      const key = o.createdAt.toISOString().slice(0, 10);
      countByDay[key] = (countByDay[key] || 0) + 1;
    }

    const result = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, count: countByDay[key] || 0 });
    }

    res.json(result);
  } catch (err) {
    console.error('Analytics orders-by-day error:', err);
    res.status(500).json({ error: 'Failed to fetch orders by day' });
  }
});

// GET /api/analytics/top-products
router.get('/top-products', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;

    const rows = await prisma.order.groupBy({
      by: ['product'],
      where: { businessId, NOT: [{ product: '' }, { product: 'Unspecified' }] },
      _count: { product: true },
      _sum: { totalPrice: true },
      orderBy: { _count: { product: 'desc' } },
      take: 5,
    });

    const result = rows.map((r) => ({
      product: r.product,
      count: r._count.product,
      revenue: r._sum.totalPrice ?? 0,
    }));

    res.json(result);
  } catch (err) {
    console.error('Analytics top-products error:', err);
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// GET /api/analytics/top-cities
router.get('/top-cities', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;

    const rows = await prisma.order.groupBy({
      by: ['address'],
      where: { businessId, NOT: { address: null }, address: { not: '' } },
      _count: { address: true },
      orderBy: { _count: { address: 'desc' } },
      take: 5,
    });

    const result = rows
      .filter((r) => r.address)
      .map((r) => ({ city: r.address as string, count: r._count.address }));

    res.json(result);
  } catch (err) {
    console.error('Analytics top-cities error:', err);
    res.status(500).json({ error: 'Failed to fetch top cities' });
  }
});

// GET /api/analytics/top-clients
router.get('/top-clients', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;

    const rows = await prisma.order.groupBy({
      by: ['customerPhone', 'customerName'],
      where: { businessId },
      _count: { id: true },
      _sum: { totalPrice: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });

    const result = rows.map((r) => ({
      name: r.customerName,
      phone: r.customerPhone,
      count: r._count.id,
      revenue: r._sum.totalPrice ?? 0,
    }));

    res.json(result);
  } catch (err) {
    console.error('Analytics top-clients error:', err);
    res.status(500).json({ error: 'Failed to fetch top clients' });
  }
});

export default router;
