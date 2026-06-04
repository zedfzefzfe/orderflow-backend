import { Router, Request, Response } from 'express';
import type { Business } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { parseOrderMessage } from '../services/llmParser.js';
import { notifyOwner } from '../services/whatsapp.js';
import type { ParsedOrder } from '../services/llmParser.js';

const router = Router();

// Meta webhook verification (GET)
router.get('/', (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verification successful');
    res.status(200).send(challenge);
    return;
  }

  console.warn('[webhook] Verification failed — token mismatch');
  res.sendStatus(403);
});

// Incoming messages (POST) — handles both Twilio and Meta payloads
router.post('/', (req: Request, res: Response): void => {
  console.log('[webhook] POST received — raw payload:', JSON.stringify(req.body));

  // Twilio sends urlencoded with Body + From starting with "whatsapp:"
  if (typeof req.body.Body === 'string' && typeof req.body.From === 'string' && req.body.From.startsWith('whatsapp:')) {
    handleTwilioPayload(req, res).catch((err) => {
      console.error('[webhook/twilio] Processing error:', err);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });
    return;
  }

  // Meta payload — acknowledge immediately (Meta requires response within 5s)
  res.sendStatus(200);
  handleMetaPayload(req.body).catch((err) => {
    console.error('[webhook/meta] Processing error:', err);
  });
});

// --- Twilio handler (synchronous — TwiML response expected) ---

async function handleTwilioPayload(req: Request, res: Response): Promise<void> {
  const messageText = req.body.Body as string;
  const senderPhone = (req.body.From as string).replace('whatsapp:', '');
  const senderName = (req.body.ProfileName as string) || null;

  console.log(`[webhook/twilio] Message from ${senderPhone} (${senderName ?? 'no name'}): "${messageText}"`);

  const business = await prisma.business.findFirst({
    where: { whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID },
  });

  if (!business) {
    console.log('[webhook/twilio] No business found for WHATSAPP_PHONE_NUMBER_ID');
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: senderPhone, body: messageText, parsed: false },
  });

  const parsed = await parseOrderMessage(messageText);
  console.log('[webhook/twilio] Parsed result:', JSON.stringify(parsed));

  const replyText = await processParsedOrder({ business, parsed, senderPhone, senderName, messageText, source: 'twilio' });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${replyText}</Message>\n</Response>`;
  res.type('text/xml').send(twiml);
}

// --- Meta handler (fire-and-forget) ---

async function handleMetaPayload(body: Record<string, unknown>): Promise<void> {
  if (!body.object || !body.entry) {
    console.log('[webhook/meta] Payload has no object/entry — skipping');
    return;
  }

  const entries = body.entry as Record<string, unknown>[];

  for (const entry of entries) {
    const changes = (entry.changes as Record<string, unknown>[] | undefined) || [];

    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value?.messages) continue;

      const metadata = value.metadata as Record<string, string> | undefined;
      const phoneNumberId = metadata?.phone_number_id;

      const business = await prisma.business.findFirst({
        where: { whatsappPhoneNumberId: phoneNumberId },
      });

      if (!business) {
        console.log(`[webhook/meta] No business found for phoneNumberId: ${phoneNumberId}`);
        continue;
      }

      const messages = value.messages as Record<string, unknown>[];

      for (const message of messages) {
        if (message.type !== 'text') continue;

        const fromPhone = message.from as string;
        const textObj = message.text as Record<string, string> | undefined;
        const messageBody = textObj?.body || '';

        console.log(`[webhook/meta] Message from ${fromPhone}: "${messageBody}"`);

        await prisma.messageLog.create({
          data: { businessId: business.id, fromPhone, body: messageBody, parsed: false },
        });

        const parsed = await parseOrderMessage(messageBody);
        console.log('[webhook/meta] Parsed result:', JSON.stringify(parsed));

        await processParsedOrder({ business, parsed, senderPhone: fromPhone, senderName: null, messageText: messageBody, source: 'whatsapp' });
      }
    }
  }
}

// --- Shared order creation logic ---

async function processParsedOrder({
  business,
  parsed,
  senderPhone,
  senderName,
  messageText,
  source,
}: {
  business: Business;
  parsed: ParsedOrder;
  senderPhone: string;
  senderName: string | null;
  messageText: string;
  source: string;
}): Promise<string> {
  if (!parsed.isOrder) {
    return 'Bonjour! Envoyez-nous votre commande et nous la traiterons rapidement. 😊';
  }

  const PLAN_LIMITS: Record<string, number> = { trial: 50, starter: 200, growth: -1, pro: -1 };
  const limit = PLAN_LIMITS[business.plan] ?? 50;

  if (limit !== -1) {
    const count = await prisma.order.count({ where: { businessId: business.id } });
    if (count >= limit) {
      console.log(`[webhook] Order blocked for "${business.name}" — plan limit (${count}/${limit})`);
      return 'Désolé, la limite de commandes du plan est atteinte.';
    }
  }

  const order = await prisma.order.create({
    data: {
      businessId: business.id,
      customerName: senderName || parsed.customerName || 'Unknown',
      customerPhone: senderPhone,
      product: parsed.product || 'Unspecified',
      quantity: parsed.quantity || 1,
      address: parsed.address,
      deliveryDate: parsed.deliveryDate,
      rawMessage: messageText,
      source,
    },
  });

  console.log(`[webhook] Order created: ${order.id} for business "${business.name}"`);

  await prisma.messageLog.updateMany({
    where: { businessId: business.id, fromPhone: senderPhone, body: messageText },
    data: { parsed: true },
  });

  notifyOwner(business, order).catch((err) =>
    console.error('[webhook] Failed to notify owner:', err)
  );

  return `Commande reçue ✅ ${buildOrderSummary(parsed)}`;
}

function buildOrderSummary(parsed: ParsedOrder): string {
  const parts: string[] = [];
  if (parsed.product) parts.push(parsed.product);
  if (parsed.quantity && parsed.quantity > 1) parts.push(`x${parsed.quantity}`);
  if (parsed.address) parts.push(`→ ${parsed.address}`);
  if (parsed.deliveryDate) parts.push(`📅 ${parsed.deliveryDate}`);
  return parts.length ? parts.join(', ') : '';
}

export default router;
