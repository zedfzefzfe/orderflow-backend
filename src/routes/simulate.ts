import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { parseOrderFromMessage } from '../services/llmParser.js';

const router = Router();

// Guard: disable in production unless explicitly enabled
const simulatorEnabled = process.env.NODE_ENV !== 'production' || process.env.ENABLE_SIMULATOR === 'true';

router.post('/message', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!simulatorEnabled) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const { fromPhone, body } = req.body;

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'body is required' });
      return;
    }

    const phone = (fromPhone || '0600000000').toString().trim();
    const businessId = req.user!.businessId;
    const messageText = body.trim();

    console.log(`[simulate] businessId=${businessId} phone=${phone} message="${messageText}"`);

    const parsed = await parseOrderFromMessage(messageText);

    // Log every message regardless of whether it's an order
    await prisma.messageLog.create({
      data: { businessId, fromPhone: phone, body: messageText, parsed: parsed.isOrder },
    }).catch((err: unknown) => console.error('[simulate] MessageLog write failed:', err));

    if (!parsed.isOrder) {
      res.json({ success: true, isOrder: false, parsed, message: 'Message analysé mais pas une commande' });
      return;
    }

    const order = await prisma.order.create({
      data: {
        businessId,
        customerName: parsed.customerName || 'Client WhatsApp',
        customerPhone: phone,
        product: parsed.product || 'Produit non spécifié',
        quantity: parsed.quantity || 1,
        address: parsed.address,
        deliveryDate: parsed.deliveryDate,
        totalPrice: parsed.totalPrice,
        rawMessage: messageText,
        source: 'simulator',
      },
    });

    console.log(`[simulate] Created order ${order.id} — ${order.customerName}`);
    res.json({ success: true, isOrder: true, order, parsed });
  } catch (err) {
    console.error('[simulate] Error:', err);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

export default router;
