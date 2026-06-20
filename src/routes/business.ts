import { Router } from 'express';
import webpush from 'web-push';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { sendAllWeeklyReports } from '../services/weeklyReport.js';

if (process.env.VAPID_EMAIL && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

const router = Router();

const PLAN_LIMITS: Record<string, number> = {
  trial: 20,
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

    const limit = PLAN_LIMITS[business.plan] ?? 20;
    const usagePercent = limit === -1 ? 0 : Math.round((orderCount / limit) * 100);

    res.json({
      id: business.id,
      name: business.name,
      plan: business.plan,
      trialEndsAt: business.trialEndsAt,
      ownerNotifyPhone: business.ownerNotifyPhone,
      whatsappPhoneNumberId: business.whatsappPhoneNumberId,
      email: business.email,
      confirmationTemplate: business.confirmationTemplate,
      formulaireTemplate: business.formulaireTemplate,
      weeklyReportEnabled: business.weeklyReportEnabled,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
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

// PATCH /api/business/me — update editable business fields
router.patch('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { name, ownerNotifyPhone, confirmationTemplate, formulaireTemplate, email, weeklyReportEnabled } = req.body;
    const data: Record<string, unknown> = {};

    if (name !== undefined) data.name = String(name).trim();
    if (ownerNotifyPhone !== undefined) data.ownerNotifyPhone = ownerNotifyPhone ? String(ownerNotifyPhone).trim() : null;
    if (confirmationTemplate !== undefined) data.confirmationTemplate = confirmationTemplate ? String(confirmationTemplate) : null;
    if (formulaireTemplate !== undefined) data.formulaireTemplate = formulaireTemplate ? String(formulaireTemplate) : null;
    if (email !== undefined) data.email = email ? String(email).trim().toLowerCase() : null;
    if (weeklyReportEnabled !== undefined) data.weeklyReportEnabled = Boolean(weeklyReportEnabled);

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No fields to update' }); return;
    }

    const business = await prisma.business.update({
      where: { id: req.user!.businessId },
      data,
    });

    res.json({ success: true, business });
  } catch (err) {
    console.error('Business patch error:', err);
    res.status(500).json({ error: 'Failed to update business' });
  }
});

// POST /api/business/test-weekly-report — send report now (dev/test)
router.post('/test-weekly-report', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user!.businessId },
    });
    if (!business?.email) {
      res.status(400).json({ error: 'No email configured — add one in Settings first' });
      return;
    }
    await sendAllWeeklyReports();
    res.json({ success: true, message: `Report sent to ${business.email}` });
  } catch (err) {
    console.error('[TEST-REPORT] Error:', err);
    res.status(500).json({ error: 'Failed to send test report' });
  }
});

// POST /api/business/push-subscription — save browser push subscription
router.post('/push-subscription', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    await prisma.business.update({
      where: { id: businessId },
      data: { pushSubscription: JSON.stringify(req.body) },
    });
    res.json({ success: true });
    console.log('[PUSH] Subscription saved for business:', businessId);
  } catch (err) {
    console.error('[PUSH] Save subscription error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
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
