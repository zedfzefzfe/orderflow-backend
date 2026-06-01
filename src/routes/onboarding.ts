import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// POST /api/onboarding — save WhatsApp Phone Number ID + Business Account ID
router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { phoneNumberId, businessAccountId } = req.body;

    if (!phoneNumberId?.trim() || !businessAccountId?.trim()) {
      res.status(400).json({ error: 'Both phoneNumberId and businessAccountId are required' });
      return;
    }

    await prisma.business.update({
      where: { id: req.user!.businessId },
      data: {
        whatsappPhoneNumberId: phoneNumberId.trim(),
        whatsappBusinessAccountId: businessAccountId.trim(),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Onboarding save error:', err);
    res.status(500).json({ error: 'Failed to save WhatsApp credentials' });
  }
});

// POST /api/onboarding/test-connection — verify WhatsApp API credentials
router.post('/test-connection', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user!.businessId },
    });

    if (!business?.whatsappPhoneNumberId) {
      res.status(400).json({ error: 'No Phone Number ID saved yet' });
      return;
    }

    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const version = process.env.WHATSAPP_API_VERSION || 'v18.0';

    if (!token) {
      res.status(500).json({ error: 'WHATSAPP_ACCESS_TOKEN not configured on server' });
      return;
    }

    const response = await fetch(
      `https://graph.facebook.com/${version}/${business.whatsappPhoneNumberId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      res.status(400).json({
        success: false,
        error: (data.error as Record<string, string>)?.message || 'Connection failed',
      });
      return;
    }

    res.json({ success: true, phoneNumberName: data.display_phone_number || data.id });
  } catch (err) {
    console.error('Onboarding test-connection error:', err);
    res.status(500).json({ error: 'Connection test failed' });
  }
});

export default router;
