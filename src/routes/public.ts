// ── Public landing-page endpoints (NO auth) ──────────────────────────────────
// Receives COD orders from a product landing page and drops them into the same
// orders table the dashboard already reads, flagged needsReview + source
// 'landing_page' so the merchant sees "new order — call to confirm". Fires the
// owner's web-push so they can call within minutes (what wins COD).

import { Router, Request, Response } from 'express';
import webpush from 'web-push';
import { prisma } from '../lib/prisma.js';

if (process.env.VAPID_EMAIL && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

async function notifyOwnerPush(
  businessId: string,
  order: { id: string; customerName: string; product: string; customerPhone: string },
): Promise<void> {
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business?.pushSubscription) return;
    await webpush.sendNotification(
      JSON.parse(business.pushSubscription),
      JSON.stringify({
        title: '📞 Nouvelle commande — à rappeler !',
        body: `${order.customerName} · ${order.product}\n${order.customerPhone}`,
        url: '/',
      }),
    );
    console.log('[public-order] push sent for order', order.id);
  } catch (err) {
    console.error('[public-order] push failed:', err);
  }
}

// Tiny in-memory rate limit per IP so a bot can't flood the orders table.
// Resets on restart — good enough as a first guard; a real limiter can come later.
const hits = new Map<string, { count: number; ts: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const WINDOW_MS = 60_000;
  const MAX = 8;
  const rec = hits.get(ip);
  if (!rec || now - rec.ts > WINDOW_MS) {
    hits.set(ip, { count: 1, ts: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX;
}

const router = Router();

// GET /api/public/health — lets the landing page wake the server (free-tier spin-up)
router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// POST /api/public/order/:businessId — create a COD order from a landing page
router.post('/order/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';
    if (rateLimited(ip)) {
      res.status(429).json({ error: 'Trop de demandes, réessayez dans un instant.' });
      return;
    }

    const { name, phone, city, product, color, quantity, price } = req.body as Record<string, unknown>;

    const customerName = String(name ?? '').trim();
    const customerPhone = String(phone ?? '').replace(/\s+/g, '');
    const productName = String(product ?? '').trim();
    const colorStr = String(color ?? '').trim();
    const cityStr = String(city ?? '').trim();

    if (!customerName || !customerPhone || !productName) {
      res.status(400).json({ error: 'Nom, téléphone et produit sont obligatoires.' });
      return;
    }

    const digits = customerPhone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 13) {
      res.status(400).json({ error: 'Numéro de téléphone invalide.' });
      return;
    }

    // Reject orders for a business that doesn't exist (bad/tampered URL)
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      res.status(404).json({ error: 'Lien invalide.' });
      return;
    }

    const qty = Math.max(1, parseInt(String(quantity ?? 1), 10) || 1);
    const priceNum =
      price != null && String(price).trim() !== '' ? parseFloat(String(price)) : null;
    const totalPrice = priceNum != null && !isNaN(priceNum) ? priceNum * qty : null;

    const productLabel = colorStr ? `${productName} — ${colorStr}` : productName;
    const rawMessage =
      `🟢 Commande landing page — À RAPPELER\n` +
      `Produit: ${productLabel}\n` +
      `Quantité: ${qty}\n` +
      `Client: ${customerName}\n` +
      `Téléphone: ${customerPhone}` +
      (cityStr ? `\nVille: ${cityStr}` : '') +
      (priceNum != null && !isNaN(priceNum) ? `\nPrix: ${priceNum} DH` : '');

    const order = await prisma.order.create({
      data: {
        businessId,
        customerName,
        customerPhone,
        product: productLabel,
        quantity: qty,
        price: priceNum != null && !isNaN(priceNum) ? priceNum : null,
        totalPrice,
        city: cityStr || null,
        status: 'CONFIRMED',
        needsReview: true,
        rawMessage,
        source: 'landing_page',
      },
    });

    // Fire-and-forget: never make the customer wait on the push
    void notifyOwnerPush(businessId, {
      id: order.id,
      customerName,
      product: productLabel,
      customerPhone,
    });

    res.json({ success: true, orderId: order.id });
  } catch (err) {
    console.error('[public-order] create failed:', err);
    res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
});

export default router;
