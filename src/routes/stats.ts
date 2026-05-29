import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/stats - Dashboard stats
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;

    // Get current week's start (Monday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const [totalOrders, ordersThisWeek, pendingOrders] = await Promise.all([
      prisma.order.count({ where: { businessId } }),
      prisma.order.count({
        where: {
          businessId,
          createdAt: { gte: weekStart },
        },
      }),
      prisma.order.count({
        where: {
          businessId,
          status: { in: ['NEW', 'CONFIRMED'] },
        },
      }),
    ]);

    // Status breakdown
    const statusCounts = await prisma.order.groupBy({
      by: ['status'],
      where: { businessId },
      _count: { status: true },
    });

    const statusBreakdown = statusCounts.reduce((acc, curr) => {
      acc[curr.status] = curr._count.status;
      return acc;
    }, {} as Record<string, number>);

    res.json({
      totalOrders,
      ordersThisWeek,
      pendingOrders,
      statusBreakdown,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
