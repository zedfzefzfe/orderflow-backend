import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

const PLAN_PRICES: Record<string, number> = {
  trial: 0,
  starter: 299,
  growth: 599,
  pro: 999,
};

function requireAdmin(req: AuthenticatedRequest, res: any, next: any) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || req.user!.email !== adminEmail) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// GET /api/admin/businesses — list all businesses with order counts
router.get('/businesses', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const businesses = await prisma.business.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { orders: true } },
        users: { select: { email: true }, take: 1 },
      },
    });

    const result = businesses.map((b) => ({
      id: b.id,
      name: b.name,
      email: b.email || b.users[0]?.email || '—',
      plan: b.plan,
      orderCount: b._count.orders,
      trialEndsAt: b.trialEndsAt,
      createdAt: b.createdAt,
    }));

    res.json({ businesses: result });
  } catch (err) {
    console.error('Admin businesses error:', err);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// PATCH /api/admin/businesses/:id — change plan manually (for DH payment)
router.patch('/businesses/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { plan } = req.body;

    const validPlans = ['trial', 'starter', 'growth', 'pro'];
    if (!plan || !validPlans.includes(plan)) {
      res.status(400).json({ error: 'Invalid plan. Must be: trial, starter, growth, pro' });
      return;
    }

    const updated = await prisma.business.update({
      where: { id },
      data: { plan },
    });

    res.json({ success: true, id: updated.id, plan: updated.plan });
  } catch (err) {
    console.error('Admin update plan error:', err);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// GET /api/admin/mrr — total MRR across all paid businesses
router.get('/mrr', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const businesses = await prisma.business.findMany({
      select: { plan: true },
    });

    const mrr = businesses.reduce((sum, b) => sum + (PLAN_PRICES[b.plan] ?? 0), 0);

    const breakdown = businesses.reduce<Record<string, number>>((acc, b) => {
      acc[b.plan] = (acc[b.plan] ?? 0) + 1;
      return acc;
    }, {});

    res.json({ mrr, currency: 'DH', breakdown });
  } catch (err) {
    console.error('Admin MRR error:', err);
    res.status(500).json({ error: 'Failed to compute MRR' });
  }
});

export default router;
