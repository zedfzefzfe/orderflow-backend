import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/stats?period=today|week|month|all
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { period } = req.query;
    const now = new Date();

    let periodStart: Date | null = null;
    if (period === 'today') {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      d.setHours(0, 0, 0, 0);
      periodStart = d;
    } else if (period === 'month') {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      d.setHours(0, 0, 0, 0);
      periodStart = d;
    }

    const baseWhere = {
      businessId,
      ...(periodStart ? { createdAt: { gte: periodStart } } : {}),
    };

    // For the "ordersThisWeek" sub-stat always show current week regardless of period
    const dayOfWeek = now.getDay();
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const [totalOrders, ordersThisWeek, pendingOrders, statusCounts] = await Promise.all([
      prisma.order.count({ where: baseWhere }),
      prisma.order.count({ where: { businessId, createdAt: { gte: weekStart } } }),
      prisma.order.count({ where: { ...baseWhere, status: { in: ['NEW', 'CONFIRMED'] } } }),
      prisma.order.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { status: true },
      }),
    ]);

    const statusBreakdown = statusCounts.reduce<Record<string, number>>((acc, curr) => {
      acc[curr.status] = curr._count.status;
      return acc;
    }, {});

    res.json({ totalOrders, ordersThisWeek, pendingOrders, statusBreakdown });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
