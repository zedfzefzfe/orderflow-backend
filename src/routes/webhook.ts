import { Router, Request, Response } from 'express';
import type { Business } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { isClientFormResponse } from '../services/llmParser.js';
import { notifyOwner } from '../services/whatsapp.js';
import { transcribeAudio, resolveMetaMediaUrl } from '../services/transcription.js';

const router = Router();

// ── Trigger keywords (merchant sends one of these to confirm an order) ─────────

const TRIGGER_KEYWORDS = [
  'commande confirmée',
  'commande confirmer',
  'commande confirmee',
  'commande confirm',
  '#confirmer',
  '#commande',
  'تأكيد الطلب',
  'commande ok',
];

function isTriggerMessage(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Role detection: sender matching ownerNotifyPhone → merchant ────────────────
// Normalize to digits-only E.164 so all MA formats compare equal:
//   +212625869380  → 212625869380
//    212625869380  → 212625869380
//      0625869380  → 212625869380  (local 0X → 212X)

function normPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  return d.length === 10 && d.startsWith('0') ? '212' + d.slice(1) : d;
}

function detectRole(senderPhone: string, business: Business): 'client' | 'merchant' {
  if (!business.ownerNotifyPhone) {
    console.warn('[role] ownerNotifyPhone is NOT set for business:', business.id, '— all senders treated as clients');
    return 'client';
  }
  const normSender = normPhone(senderPhone);
  const normOwner  = normPhone(business.ownerNotifyPhone);
  const match = normSender === normOwner;
  console.log(`[role] sender=${senderPhone}(${normSender}) owner=${business.ownerNotifyPhone}(${normOwner}) match=${match}`);
  return match ? 'merchant' : 'client';
}

// ── Persists one message to ConversationMessage table ─────────────────────────

async function saveConversationMessage(
  businessId: string,
  phone: string,
  role: 'client' | 'merchant',
  type: 'text' | 'audio' | 'image',
  content: string,
  mediaUrl?: string,
  processed = false,
): Promise<void> {
  await prisma.conversationMessage.create({
    data: { businessId, phone, role, type, content, mediaUrl: mediaUrl || null, processed },
  });
  console.log(`[convo] Saved [${role}/${type}${processed ? '/processed' : ''}] for phone ${phone}: "${content.slice(0, 60)}"`);
}

// ── When merchant sends trigger: find the most recent active customer ──────────

async function resolveCustomerPhone(businessId: string, senderPhone: string, role: 'client' | 'merchant'): Promise<string | null> {
  if (role === 'client') return senderPhone;

  const recent = await prisma.conversationMessage.findFirst({
    where: { businessId, role: 'client' },
    orderBy: { createdAt: 'desc' },
  });

  if (!recent) {
    console.warn('[webhook/trigger] No active client conversation found for this business');
    return null;
  }

  return recent.phone;
}

async function markConversationProcessed(businessId: string, phone: string): Promise<void> {
  const { count } = await prisma.conversationMessage.updateMany({
    where: { businessId, phone, processed: false },
    data: { processed: true },
  });
  console.log(`[TRIGGER] Marked ${count} messages as processed for ${phone}`);
}

// ── Outbound WhatsApp via yCloud ───────────────────────────────────────────────

async function sendWhatsAppMessage(to: string, message: string, _businessId: string): Promise<void> {
  const toFormatted = to.startsWith('+') ? to : `+${to}`;
  try {
    const response = await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.YCLOUD_API_KEY || '',
      },
      body: JSON.stringify({
        from: process.env.YCLOUD_WHATSAPP_NUMBER || '',
        to: toFormatted,
        type: 'text',
        text: { body: message },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[yCloud] Send failed:', JSON.stringify(data));
    } else {
      console.log('[yCloud] Message sent to:', to);
    }
  } catch (error) {
    console.error('[yCloud] Send error:', error);
  }
}

async function sendWhatsAppMessageToMerchant(text: string, businessId: string): Promise<void> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business?.ownerNotifyPhone) {
    console.warn('[sendWhatsAppMessageToMerchant] No ownerNotifyPhone for business:', businessId);
    return;
  }
  await sendWhatsAppMessage(business.ownerNotifyPhone, text, businessId);
}

// ── Trigger message parser ─────────────────────────────────────────────────────

function parseTriggerDetails(lines: string[]) {
  const details = lines.filter(l => !l.toLowerCase().includes('commande confirm'));
  const productLine = details[0] || null;
  const priceLine = details.find(l => /\d+\s*dh/i.test(l) && !/livraison/i.test(l));
  const deliveryLine = details.find(l => /livraison/i.test(l));
  const quantityLine = details.find(l => /^x?\d+$/i.test(l.trim()));
  return {
    product: productLine,
    price: priceLine ? parseInt(priceLine.match(/(\d+)/)?.[1] || '0') : null,
    deliveryPrice: deliveryLine ? parseInt(deliveryLine.match(/(\d+)/)?.[1] || '0') : 0,
    quantity: quantityLine ? parseInt(quantityLine.match(/(\d+)/)?.[1] || '1') : 1,
  };
}

// ── Core trigger handler: single-trigger order flow ────────────────────────────
// Merchant sends ONE trigger with product details → formulaire goes to client.
// No second trigger needed — client response creates the order directly.

async function handleTrigger(business: Business, customerPhone: string, messageText: string): Promise<void> {
  const businessId = business.id;

  // Strip trigger keyword line, parse product details from the rest
  const lines = messageText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.toLowerCase().includes('commande confirm'));

  const productInfo = parseTriggerDetails(lines);
  console.log('[TRIGGER] Product info from merchant:', productInfo);

  // Require at least a product name
  if (!productInfo.product) {
    console.log('[TRIGGER] No product found — sending format hint to merchant');
    await sendWhatsAppMessageToMerchant(
      `⚠️ Format incorrect. Envoyez :\n"commande confirmée\n[nom du produit]\n[prix]dh\nlivraison [prix livraison]dh"\n\nExemple :\ncommande confirmée\nbouquet rose rouge\n299dh\nlivraison 25dh`,
      businessId
    );
    return;
  }

  // Plan limit check — applies once the order is ultimately created, but
  // we block early so the merchant knows before waiting for client info.
  const PLAN_LIMITS: Record<string, number> = { trial: 50, starter: 200, growth: -1, pro: -1 };
  const limit = PLAN_LIMITS[business.plan] ?? 50;
  if (limit !== -1) {
    const count = await prisma.order.count({ where: { businessId } });
    if (count >= limit) {
      console.log(`[TRIGGER] Order blocked for "${business.name}" — plan limit (${count}/${limit})`);
      return;
    }
  }

  // Upsert pending order — update if one exists for this customer, create otherwise
  const existingPending = await prisma.pendingOrder.findFirst({
    where: {
      businessId,
      customerPhone,
      status: { in: ['WAITING_CLIENT_INFO', 'WAITING_MERCHANT_CONFIRMATION'] },
    },
  });

  if (existingPending) {
    await prisma.pendingOrder.update({
      where: { id: existingPending.id },
      data: {
        product: productInfo.product,
        price: productInfo.price,
        deliveryPrice: productInfo.deliveryPrice,
        status: 'WAITING_CLIENT_INFO',
      },
    });
    console.log('[TRIGGER] Updated existing pending order:', existingPending.id);
  } else {
    await prisma.pendingOrder.create({
      data: {
        businessId,
        customerPhone,
        product: productInfo.product,
        price: productInfo.price,
        deliveryPrice: productInfo.deliveryPrice,
        status: 'WAITING_CLIENT_INFO',
      },
    });
    console.log('[TRIGGER] Created new pending order');
  }

  // Send formulaire to client — includes product details so they know what they ordered
  const formulaire = `✅ Commande notée ! 🌸
تم تسجيل طلبك !

📦 ${productInfo.product}
💰 ${productInfo.price ? productInfo.price + ' DH' : 'Prix à confirmer'}
🚚 Livraison : ${productInfo.deliveryPrice ? productInfo.deliveryPrice + ' DH' : 'Gratuite 🎁'}

Pour finaliser, envoyez en un message :
لإتمام الطلب، أرسل في رسالة واحدة :

👤 Votre nom / اسمك
📍 Votre adresse / عنوانك
🗓️ Date souhaitée / تاريخ التوصيل

Exemple :
Fatima Zahra
Hay Mohammadi Bloc 5 Casablanca
Samedi 8 juin`;

  await sendWhatsAppMessage(customerPhone, formulaire, businessId);
  console.log('[FLOW] Formulaire sent to client:', customerPhone);
}

// ── Meta webhook verification (GET) ───────────────────────────────────────────

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

// ── Incoming messages (POST) ──────────────────────────────────────────────────

router.post('/', (req: Request, res: Response): void => {
  console.log('[webhook] POST received — raw payload:', JSON.stringify(req.body));

  if (typeof req.body.Body === 'string' && typeof req.body.From === 'string' && req.body.From.startsWith('whatsapp:')) {
    handleTwilioPayload(req, res).catch((err) => {
      console.error('[webhook/twilio] Processing error:', err);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });
    return;
  }

  if (req.body.type === 'whatsapp.inbound_message.received' && req.body.whatsappInboundMessage) {
    res.status(200).json({ received: true });
    handleYCloudPayload(req.body).catch((err) => {
      console.error('[webhook/ycloud] Processing error:', err);
    });
    return;
  }

  if (req.body.type === 'whatsapp.smb.message.echoes' && req.body.whatsappMessage) {
    res.status(200).json({ received: true });
    handleYCloudEcho(req.body).catch((err) => {
      console.error('[webhook/ycloud/echo] Processing error:', err);
    });
    return;
  }

  res.sendStatus(200);
  handleMetaPayload(req.body).catch((err) => {
    console.error('[webhook/meta] Processing error:', err);
  });
});

// ── Twilio handler ─────────────────────────────────────────────────────────────

async function handleTwilioPayload(req: Request, res: Response): Promise<void> {
  const senderPhone = (req.body.From as string).replace('whatsapp:', '');
  const messageText = req.body.Body as string;
  const mediaUrl0 = req.body.MediaUrl0 as string | undefined;
  const mediaType = req.body.MediaContentType0 as string | undefined;

  const business = await prisma.business.findFirst({
    where: { whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID },
  });

  if (!business) {
    console.log('[webhook/twilio] No business found for WHATSAPP_PHONE_NUMBER_ID');
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  const role = detectRole(senderPhone, business);
  const customerPhone = await resolveCustomerPhone(business.id, senderPhone, role);

  if (!customerPhone) {
    console.warn('[webhook/twilio] Could not resolve customerPhone — skipping');
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  let type: 'text' | 'audio' | 'image' = 'text';
  let content = messageText || '';
  if (mediaUrl0 && mediaType) {
    if (mediaType.startsWith('audio/')) {
      type = 'audio';
      const transcription = await transcribeAudio(mediaUrl0);
      content = `[Audio transcrit]: ${transcription}`;
    } else if (mediaType.startsWith('image/')) {
      type = 'image';
      content = '[Image envoyée]';
    }
  }

  const isTwilioTrigger = role === 'merchant' && type === 'text' && isTriggerMessage(content);
  await saveConversationMessage(business.id, customerPhone, role, type, content, mediaUrl0, isTwilioTrigger);

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: senderPhone, body: messageText || content, parsed: false },
  });

  if (isTwilioTrigger) {
    console.log(`[webhook/twilio] Trigger detected from merchant ${senderPhone} for customer ${customerPhone}`);
    handleTrigger(business, customerPhone, content).catch((err) =>
      console.error('[webhook/twilio] handleTrigger error:', err)
    );
  }

  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ── Meta handler ───────────────────────────────────────────────────────────────

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
        const senderPhone = message.from as string;
        const msgType = message.type as string;
        const role = detectRole(senderPhone, business);
        const customerPhone = await resolveCustomerPhone(business.id, senderPhone, role);

        if (!customerPhone) {
          console.warn(`[webhook/meta] Could not resolve customerPhone for ${senderPhone} — skipping`);
          continue;
        }

        let type: 'text' | 'audio' | 'image' = 'text';
        let content = '';
        let mediaUrl: string | undefined;

        if (msgType === 'text') {
          const textObj = message.text as Record<string, string> | undefined;
          content = textObj?.body || '';
        } else if (msgType === 'audio' || msgType === 'voice') {
          type = 'audio';
          const audioObj = (message.audio ?? message.voice) as Record<string, string> | undefined;
          const mediaId = audioObj?.id;
          if (mediaId) {
            const resolvedUrl = await resolveMetaMediaUrl(mediaId);
            if (resolvedUrl) {
              mediaUrl = resolvedUrl;
              const transcription = await transcribeAudio(resolvedUrl, process.env.WHATSAPP_ACCESS_TOKEN);
              content = `[Audio transcrit]: ${transcription}`;
            } else {
              content = '[Audio - URL indisponible]';
            }
          } else {
            content = '[Audio]';
          }
        } else if (msgType === 'image') {
          type = 'image';
          const imageObj = message.image as Record<string, string> | undefined;
          content = imageObj?.caption || '[Image envoyée]';
          mediaUrl = imageObj?.id;
        } else {
          console.log(`[webhook/meta] Skipping unsupported message type: ${msgType}`);
          continue;
        }

        const isMetaTrigger = role === 'merchant' && type === 'text' && isTriggerMessage(content);
        await saveConversationMessage(business.id, customerPhone, role, type, content, mediaUrl, isMetaTrigger);

        await prisma.messageLog.create({
          data: { businessId: business.id, fromPhone: senderPhone, body: content, parsed: false },
        });

        if (isMetaTrigger) {
          console.log(`[webhook/meta] Trigger detected from merchant ${senderPhone} for customer ${customerPhone}`);
          handleTrigger(business, customerPhone, content).catch((err) =>
            console.error('[webhook/meta] handleTrigger error:', err)
          );
        }
      }
    }
  }
}

// ── YCloud inbound handler (client → business) ─────────────────────────────────

async function handleYCloudPayload(body: Record<string, unknown>): Promise<void> {
  const msg = body.whatsappInboundMessage as Record<string, unknown>;
  const msgType = msg.type as string;
  const senderPhone = msg.from as string;
  const profile = msg.customerProfile as Record<string, string> | undefined;
  const wabaId = msg.wabaId as string | undefined;

  // Diagnostic — tells us the exact event shape hitting this handler
  console.log(`[webhook/ycloud] inbound event | from=${senderPhone} | to=${msg.to ?? '?'} | type=${msgType} | wabaId=${wabaId}`);

  const business = await prisma.business.findFirst({
    where: { whatsappBusinessAccountId: wabaId },
  });

  if (!business) {
    console.log(`[webhook/ycloud] No business found for wabaId: ${wabaId}`);
    return;
  }

  // Debug — lets us verify what phone fields are stored so we can diagnose role-detection failures
  console.log('[DEBUG] Business phones:', {
    id: business.id,
    name: business.name,
    ownerNotifyPhone: business.ownerNotifyPhone,
    whatsappPhoneNumberId: business.whatsappPhoneNumberId,
    whatsappBusinessAccountId: business.whatsappBusinessAccountId,
  });

  const role = detectRole(senderPhone, business);
  const customerPhone = await resolveCustomerPhone(business.id, senderPhone, role);

  if (!customerPhone) {
    console.warn(`[webhook/ycloud] Could not resolve customerPhone for ${senderPhone} — skipping`);
    return;
  }

  let type: 'text' | 'audio' | 'image' = 'text';
  let content = '';
  let mediaUrl: string | undefined;

  if (msgType === 'text') {
    const textObj = msg.text as Record<string, string> | undefined;
    content = textObj?.body || '';
  } else if (msgType === 'audio' || msgType === 'voice') {
    type = 'audio';
    const audioObj = (msg.audio ?? msg.voice) as Record<string, unknown> | undefined;
    console.log('[GROQ] yCloud audio object:', JSON.stringify(audioObj));
    mediaUrl = (audioObj?.url ?? audioObj?.link ?? audioObj?.cdnUrl ?? audioObj?.downloadUrl) as string | undefined;
    const mimeHint = (audioObj?.mimeType ?? audioObj?.mime_type ?? '') as string;
    console.log('[GROQ] yCloud audio URL:', mediaUrl ?? '(not found)');
    console.log('[GROQ] yCloud audio mime_type:', mimeHint || '(not provided)');
    if (mediaUrl) {
      console.log('[GROQ] Attempting to transcribe yCloud audio');
      const transcription = await transcribeAudio(mediaUrl, undefined);
      content = `[Audio transcrit]: ${transcription}`;
      console.log('[GROQ] Transcription result:', transcription.substring(0, 100));
    } else {
      content = '[Audio - URL manquante]';
      console.log('[GROQ] No audio URL found in yCloud message — check audioObj above for correct field name');
    }
  } else if (msgType === 'image') {
    type = 'image';
    const imageObj = msg.image as Record<string, string> | undefined;
    content = imageObj?.caption || '[Image envoyée]';
    mediaUrl = imageObj?.url;
  } else {
    console.log(`[webhook/ycloud] Skipping unsupported message type: ${msgType}`);
    return;
  }

  const senderName = profile?.name || null;
  console.log(`[webhook/ycloud] Message from ${senderPhone} (${senderName ?? 'no name'}) [${role}/${type}]`);

  // ── Client form-response detection ─────────────────────────────────────────
  // If a pending order is waiting for this client's info, use Claude Haiku to
  // check whether the message is a delivery form response, and if so create the order.

  if (role === 'client' && type === 'text') {
    const pendingOrder = await prisma.pendingOrder.findFirst({
      where: { businessId: business.id, customerPhone, status: 'WAITING_CLIENT_INFO' },
      orderBy: { createdAt: 'desc' },
    });

    if (pendingOrder) {
      console.log('[FLOW] Pending order waiting for client info:', pendingOrder.id);

      const { isResponse, name, phone, address, deliveryDate } = await isClientFormResponse(content);

      if (!isResponse) {
        console.log('[FLOW] Message ignored — Claude says not a form response');
      } else {
        console.log('[FLOW] Valid form response — creating order:', { name, phone, address, deliveryDate });

        const clientPhone = phone || customerPhone;

        const order = await prisma.order.create({
          data: {
            businessId: business.id,
            customerName: name || 'Client WhatsApp',
            customerPhone: clientPhone,
            product: pendingOrder.product || 'À préciser',
            quantity: 1,
            address: address || null,
            deliveryDate: deliveryDate || null,
            price: pendingOrder.price || null,
            deliveryPrice: pendingOrder.deliveryPrice || 0,
            status: 'CONFIRMED',
            needsReview: !address || !name,
            rawMessage: content,
            source: 'whatsapp',
          },
        });

        console.log('[ORDER] Created:', order.id);

        await prisma.pendingOrder.update({
          where: { id: pendingOrder.id },
          data: { status: 'COMPLETED' },
        });

        const total = ((pendingOrder.price || 0) + (pendingOrder.deliveryPrice || 0));

        const confirmation = `✅ Commande confirmée ! 🌸
تم تأكيد طلبك !

👤 ${order.customerName}
📦 ${order.product}
💰 Prix : ${pendingOrder.price ? pendingOrder.price + ' DH' : 'À confirmer'}
🚚 Livraison : ${pendingOrder.deliveryPrice ? pendingOrder.deliveryPrice + ' DH' : 'Gratuite 🎁'}
💵 Total : ${total > 0 ? total + ' DH' : 'À confirmer'}
📍 ${order.address || 'À confirmer'}
🗓️ ${order.deliveryDate || 'À confirmer'}

Merci pour votre confiance ! 🙏
شكراً على ثقتكم !`;

        await sendWhatsAppMessage(customerPhone, confirmation, business.id);
        console.log('[CONFIRM] Sent to client:', customerPhone);

        notifyOwner(business, order).catch((err) => console.error('[FLOW] notifyOwner error:', err));
        await markConversationProcessed(business.id, customerPhone);
      }
    }
  }

  const isYCloudTrigger = role === 'merchant' && type === 'text' && isTriggerMessage(content);
  await saveConversationMessage(business.id, customerPhone, role, type, content, mediaUrl, isYCloudTrigger);

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: senderPhone, body: content, parsed: false },
  });

  if (isYCloudTrigger) {
    console.log(`[webhook/ycloud] Trigger detected from merchant ${senderPhone} for customer ${customerPhone}`);
    handleTrigger(business, customerPhone, content).catch((err) =>
      console.error('[webhook/ycloud] handleTrigger error:', err)
    );
  }
}

// ── YCloud echo handler (merchant outbound messages) ──────────────────────────
// YCloud sends merchant's own messages as echo events so we can store them
// in conversation history and detect the "commande confirmée" trigger.

async function handleYCloudEcho(body: Record<string, unknown>): Promise<void> {
  const message = body.whatsappMessage as Record<string, unknown> | undefined;
  if (!message) {
    console.warn('[webhook/ycloud/echo] Missing whatsappMessage field — skipping');
    return;
  }

  const msgType = (message.type as string | undefined) || 'text';
  const merchantPhone = message.from as string | undefined;
  const customerPhone = message.to as string | undefined;
  const wabaId = (message.wabaId ?? body.wabaId) as string | undefined;

  if (!customerPhone || !merchantPhone) {
    console.warn('[webhook/ycloud/echo] Missing from/to fields — skipping');
    return;
  }

  const business = await prisma.business.findFirst({
    where: { whatsappBusinessAccountId: wabaId },
  });

  if (!business) {
    console.log(`[webhook/ycloud/echo] No business found for wabaId: ${wabaId}`);
    return;
  }

  let content = '';
  if (msgType === 'text') {
    const textObj = message.text as Record<string, string> | undefined;
    content = textObj?.body || '';
  } else if (msgType === 'audio' || msgType === 'voice') {
    const audioObj = (message.audio ?? message.voice) as Record<string, unknown> | undefined;
    console.log('[GROQ] yCloud echo audio object:', JSON.stringify(audioObj));
    const audioUrl = (audioObj?.url ?? audioObj?.link ?? audioObj?.cdnUrl ?? audioObj?.downloadUrl) as string | undefined;
    console.log('[GROQ] yCloud echo audio URL:', audioUrl ?? '(not found)');
    if (audioUrl) {
      const transcription = await transcribeAudio(audioUrl, undefined);
      content = `[Audio transcrit]: ${transcription}`;
    } else {
      content = '[Audio - URL manquante]';
      console.log('[GROQ] No audio URL in echo — check echo audioObj above');
    }
  } else if (msgType === 'image') {
    const imageObj = message.image as Record<string, string> | undefined;
    content = imageObj?.caption || '[Image envoyée]';
  } else {
    content = `[Message type: ${msgType}]`;
  }

  console.log(`[webhook/ycloud/echo] Merchant message to ${customerPhone}: "${content.slice(0, 80)}"`);

  const echoType: 'text' | 'audio' | 'image' =
    msgType === 'audio' || msgType === 'voice' ? 'audio' : msgType === 'image' ? 'image' : 'text';

  const isEchoTrigger = echoType === 'text' && isTriggerMessage(content);
  console.log(`[webhook/ycloud/echo] Is trigger: ${isEchoTrigger}`);

  await saveConversationMessage(business.id, customerPhone, 'merchant', echoType, content, undefined, isEchoTrigger);

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: merchantPhone, body: content, parsed: false },
  }).catch(() => {/* non-critical */});

  if (isEchoTrigger) {
    console.log(`[TRIGGER] Commande confirmée detected from merchant! Customer phone: ${customerPhone}`);
    handleTrigger(business, customerPhone, content).catch((err) =>
      console.error('[webhook/ycloud/echo] handleTrigger error:', err)
    );
  }
}

export default router;
