import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/customers
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { riskLevel, search } = req.query as { riskLevel?: string; search?: string };

    const where: any = { businessId };

    if (riskLevel && ['FIABLE', 'A_SURVEILLER', 'MAUVAIS'].includes(riskLevel)) {
      where.riskLevel = riskLevel;
    }

    if (search) {
      where.OR = [
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      orderBy: { riskScore: 'desc' },
      select: {
        phone: true,
        names: true,
        totalOrders: true,
        delivered: true,
        clientFaultReturns: true,
        reporteClient: true,
        legitReturns: true,
        faultPoints: true,
        riskScore: true,
        riskLevel: true,
        lastOrderAt: true,
      },
    });

    res.json(customers);
  } catch (err) {
    console.error('Customers list error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

export default router;
