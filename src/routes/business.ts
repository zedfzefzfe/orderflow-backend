import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

const PLAN_LIMITS: Record<string, number> = {
  trial: 50,
  starter: 200,
  growth: -1,
  pro: -1,
};

// GET /api/business/me — plan info + usage
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user!.businessId },
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const orderCount = await prisma.order.count({
      where: { businessId: business.id },
    });

    const limit = PLAN_LIMITS[business.plan] ?? 50;
    const usagePercent = limit === -1 ? 0 : Math.round((orderCount / limit) * 100);

    res.json({
      id: business.id,
      name: business.name,
      plan: business.plan,
      trialEndsAt: business.trialEndsAt,
      orderCount,
      orderLimit: limit,
      usagePercent,
      isUnlimited: limit === -1,
      limitReached: limit !== -1 && orderCount >= limit,
      nearLimit: limit !== -1 && usagePercent >= 80 && orderCount < limit,
    });
  } catch (err) {
    console.error('Business me error:', err);
    res.status(500).json({ error: 'Failed to fetch business info' });
  }
});

// POST /api/business/signup — called after Supabase signup to set boutique name + phone
router.post('/signup', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { boutiqueName, whatsappPhoneNumber } = req.body;

    if (!boutiqueName?.trim()) {
      res.status(400).json({ error: 'Boutique name is required' });
      return;
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    const business = await prisma.business.update({
      where: { id: req.user!.businessId },
      data: {
        name: boutiqueName.trim(),
        email: req.user!.email,
        ownerNotifyPhone: whatsappPhoneNumber?.trim() || null,
        plan: 'trial',
        trialEndsAt,
      },
    });

    res.json({ success: true, businessId: business.id });
  } catch (err) {
    console.error('Business signup error:', err);
    res.status(500).json({ error: 'Failed to save business info' });
  }
});

export default router;
