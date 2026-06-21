import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { getGlobalClientRisk } from '../services/customerScoring.js';

const router = Router();

// GET /api/customers/global-risk?phone=X
// Doit être déclaré AVANT /:id pour éviter le conflit de routing
router.get('/global-risk', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { phone } = req.query as { phone?: string };
    if (!phone) { res.status(400).json({ error: 'phone query param required' }); return; }

    const result = await getGlobalClientRisk(phone);
    res.json(result);
  } catch (err) {
    console.error('Global risk error:', err);
    res.status(500).json({ error: 'Failed to compute global risk' });
  }
});

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
