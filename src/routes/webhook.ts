import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { parseOrderMessage } from '../services/llmParser.js';
import { notifyOwner } from '../services/whatsapp.js';

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

// Incoming messages (POST)
// IMPORTANT: respond 200 immediately — Meta requires it within 5 seconds.
// All heavy processing (LLM, DB) runs asynchronously after the response.
router.post('/', (req: Request, res: Response): void => {
  console.log('[webhook] POST received — raw payload:', JSON.stringify(req.body));

  // Acknowledge to Meta right away
  res.sendStatus(200);

  // Fire-and-forget processing
  handleWebhookPayload(req.body).catch((err) => {
    console.error('[webhook] Processing error:', err);
  });
});

async function handleWebhookPayload(body: Record<string, unknown>): Promise<void> {
  if (!body.object || !body.entry) {
    console.log('[webhook] Payload has no object/entry — skipping');
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
        console.log(`[webhook] No business found for phoneNumberId: ${phoneNumberId}`);
        continue;
      }

      const messages = value.messages as Record<string, unknown>[];

      for (const message of messages) {
        if (message.type !== 'text') continue;

        const fromPhone = message.from as string;
        const textObj = message.text as Record<string, string> | undefined;
        const messageBody = textObj?.body || '';

        console.log(`[webhook] Message from ${fromPhone}: "${messageBody}"`);

        // Log the message
        await prisma.messageLog.create({
          data: { businessId: business.id, fromPhone, body: messageBody, parsed: false },
        });

        // Parse with LLM
        const parsed = await parseOrderMessage(messageBody);
        console.log('[webhook] Parsed result:', JSON.stringify(parsed));

        if (parsed.isOrder) {
          const order = await prisma.order.create({
            data: {
              businessId: business.id,
              customerName: parsed.customerName || 'Unknown',
              customerPhone: fromPhone,
              product: parsed.product || 'Unspecified',
              quantity: parsed.quantity || 1,
              address: parsed.address,
              deliveryDate: parsed.deliveryDate,
              rawMessage: messageBody,
              source: 'whatsapp',
            },
          });

          console.log(`[webhook] Order created: ${order.id} for business "${business.name}"`);

          await prisma.messageLog.updateMany({
            where: { businessId: business.id, fromPhone, body: messageBody },
            data: { parsed: true },
          });

          notifyOwner(business, order).catch((err) =>
            console.error('[webhook] Failed to notify owner:', err)
          );
        }
      }
    }
  }
}

export default router;
