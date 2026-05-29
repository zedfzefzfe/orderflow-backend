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
    console.log('Webhook verified');
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

// Incoming messages (POST)
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body;

    if (!body.object || !body.entry) {
      res.sendStatus(200);
      return;
    }

    // Process each entry and message
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        const phoneNumberId = value.metadata?.phone_number_id;

        // Find business by phone number ID
        const business = await prisma.business.findFirst({
          where: { whatsappPhoneNumberId: phoneNumberId },
        });

        if (!business) {
          console.log(`No business found for phoneNumberId: ${phoneNumberId}`);
          continue;
        }

        for (const message of value.messages) {
          if (message.type !== 'text') continue;

          const fromPhone = message.from;
          const messageBody = message.text?.body || '';

          // Save to message log
          await prisma.messageLog.create({
            data: {
              businessId: business.id,
              fromPhone,
              body: messageBody,
              parsed: false,
            },
          });

          // Parse with LLM
          const parsed = await parseOrderMessage(messageBody);

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

            console.log(`Order created: ${order.id} for business ${business.name}`);

            // Update message log as parsed
            await prisma.messageLog.updateMany({
              where: { businessId: business.id, fromPhone, body: messageBody },
              data: { parsed: true },
            });

            // Notify owner (non-blocking)
            notifyOwner(business, order).catch((err) =>
              console.error('Failed to notify owner:', err)
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200); // Always return 200 to Meta
  }
});

export default router;
