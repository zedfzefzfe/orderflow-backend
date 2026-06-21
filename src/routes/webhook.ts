import { Router, Request, Response } from 'express';
import type { Business } from '@prisma/client';
import webpush from 'web-push';
import { prisma } from '../lib/prisma.js';
import { classifyClientMessage } from '../services/llmParser.js';
import { notifyOwner } from '../services/whatsapp.js';
import { getGlobalClientRisk, getLocalClientWarning } from '../services/customerScoring.js';
import { extractStructuredFields } from '../services/llmParser.js';
import type { ProductCategory, MoroccanWilaya, DeliveryCompany } from '@prisma/client';
import { transcribeAudio, resolveMetaMediaUrl } from '../services/transcription.js';

if (process.env.VAPID_EMAIL && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

async function sendPushNotification(businessId: string, order: { id: string; customerName: string; product: string }): Promise<void> {
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business?.pushSubscription) return;

    const subscription = JSON.parse(business.pushSubscription);
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: '🛍️ Nouvelle commande !',
        body: `${order.customerName || 'Client'} — ${order.product || 'Produit'}`,
        url: '/',
      }),
    );
    console.log('[PUSH] Notification sent for order:', order.id);
  } catch (err) {
    console.error('[PUSH] Failed to send notification:', err);
  }
}

const router = Router();

// ── Trigger keywords (merchant sends one of these to confirm an order) ─────────

const TRIGGER_KEYWORDS = [
  'commande confirmée',
  'commande confirmer',
  'commande confirmee',
  'commande confirm',
  'votre commande confirm',
  'commande est confirm',
  'order confirmed',
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
  const details = lines.filter(l => {
    const low = l.toLowerCase();
    return !low.includes('commande confirm') && !low.includes('votre commande');
  });

  // Product = first line that has no price/delivery markers
  const productLine = details.find(l =>
    !/\d+\s*dh/i.test(l) &&
    !/livraison/i.test(l) &&
    !/prix/i.test(l) &&
    l.trim().length > 0
  ) || null;

  // Price = first line with digits + dh that isn't a delivery line
  const priceLine = details.find(l => /\d+\s*dh/i.test(l) && !/livraison/i.test(l));
  const price = priceLine ? parseInt(priceLine.match(/(\d+)/)?.[1] || '0') : null;

  console.log('[PARSER] Price line:', priceLine, '→ price:', price);

  const deliveryLine = details.find(l => /livraison/i.test(l));

  return {
    product: productLine,
    price,
    deliveryPrice: deliveryLine ? parseInt(deliveryLine.match(/(\d+)/)?.[1] || '0') : 0,
    quantity: 1,
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
    .filter(l => l && !l.toLowerCase().includes('commande confirm') && !l.toLowerCase().includes('votre commande'));

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
  const PLAN_LIMITS: Record<string, number> = { trial: 20, starter: 200, growth: -1, pro: -1 };
  const limit = PLAN_LIMITS[business.plan] ?? 20;
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

  // Send formulaire to client — use merchant's custom template if set
  const DEFAULT_FORMULAIRE = `✅ Commande notée ! 🌸
تم تسجيل طلبك !

📦 {produit}
💰 {prix}
🚚 Livraison : {livraison}

Pour finaliser, envoyez en un message :
لإتمام الطلب، أرسل في رسالة واحدة :

👤 Votre nom / اسمك
📍 Votre adresse / عنوانك
🗓️ Date souhaitée / تاريخ التوصيل

Exemple :
Fatima Zahra
Hay Mohammadi Bloc 5 Casablanca
Samedi 8 juin`;

  const freshBusiness = await prisma.business.findUnique({ where: { id: businessId } });
  const formulaireTemplate = freshBusiness?.formulaireTemplate || DEFAULT_FORMULAIRE;
  const formulaire = formulaireTemplate
    .replace('{produit}', productInfo.product || '')
    .replace('{prix}', productInfo.price ? productInfo.price + ' DH' : 'Prix à confirmer')
    .replace('{livraison}', productInfo.deliveryPrice ? productInfo.deliveryPrice + ' DH' : 'Gratuite 🎁');

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

  // ── Progressive client info collection ────────────────────────────────────
  // Each client message is classified by Claude Haiku (name / address / date /
  // phone / other).  Fields are stored one by one on the PendingOrder.
  // Once name + address + date are all collected the order is created.

  if (role === 'client' && type === 'text') {
    const pendingOrder = await prisma.pendingOrder.findFirst({
      where: { businessId: business.id, customerPhone, status: 'WAITING_CLIENT_INFO' },
      orderBy: { createdAt: 'desc' },
    });

    if (pendingOrder) {
      console.log('[FLOW] Pending order waiting for client info:', pendingOrder.id);

      const result = await classifyClientMessage(content);
      console.log('[AI] Classified:', result);

      const hasInfo = result.name || result.address || result.date || result.phone;

      if (!hasInfo) {
        console.log('[FLOW] Chat message ignored — not order info');
      } else {
        // Only fill fields that are not yet collected
        const updateData: Record<string, string> = {};
        if (result.name    && !pendingOrder.customerName) updateData.customerName = result.name;
        if (result.address && !pendingOrder.address)      updateData.address      = result.address;
        if (result.date    && !pendingOrder.deliveryDate) updateData.deliveryDate = result.date;
        if (result.phone   && !pendingOrder.phone)        updateData.phone        = result.phone;

        if (Object.keys(updateData).length > 0) {
          await prisma.pendingOrder.update({ where: { id: pendingOrder.id }, data: updateData });
          console.log('[FLOW] Updated pending order with:', updateData);
        }

        // Reload to get the latest combined state
        const updated = await prisma.pendingOrder.findUnique({ where: { id: pendingOrder.id } });

        console.log('[FLOW] Collection progress:', {
          name:    updated?.customerName  || 'missing',
          address: updated?.address       || 'missing',
          date:    updated?.deliveryDate  || 'missing',
        });

        // Create order once the three required fields are all present
        if (updated?.customerName && updated?.address && updated?.deliveryDate) {
          const clientPhone = updated.phone || customerPhone;
          console.log('[ORDER] Price from pending:', updated.price);
          const total = (updated.price || 0) + (updated.deliveryPrice || 0);

          const order = await prisma.order.create({
            data: {
              businessId: business.id,
              customerName: updated.customerName,
              customerPhone: clientPhone,
              product: updated.product || 'À préciser',
              quantity: 1,
              address: updated.address,
              deliveryDate: updated.deliveryDate,
              price: updated.price || null,
              totalPrice: updated.price || null,
              deliveryPrice: updated.deliveryPrice || 0,
              status: 'CONFIRMED',
              needsReview: false,
              rawMessage: content,
              source: 'whatsapp',
            },
          });

          await prisma.pendingOrder.update({
            where: { id: pendingOrder.id },
            data: { status: 'COMPLETED' },
          });

          const DEFAULT_CONFIRMATION = `✅ Commande confirmée ! 🌸
تم تأكيد طلبك !

👤 {nom}
📦 {produit}
💰 {prix}
🚚 Livraison : {livraison}
💵 Total : {total}
📍 {adresse}
🗓️ {date}

Merci pour votre confiance ! 🙏
شكراً على ثقتكم !`;

          const latestBusiness = await prisma.business.findUnique({ where: { id: business.id } });
          const confirmTpl = latestBusiness?.confirmationTemplate || DEFAULT_CONFIRMATION;
          const confirmation = confirmTpl
            .replace('{nom}', order.customerName)
            .replace('{produit}', updated.product || 'À préciser')
            .replace('{prix}', updated.price ? updated.price + ' DH' : 'À confirmer')
            .replace('{livraison}', updated.deliveryPrice ? updated.deliveryPrice + ' DH' : 'Gratuite 🎁')
            .replace('{total}', total > 0 ? total + ' DH' : 'À confirmer')
            .replace('{adresse}', order.address || '—')
            .replace('{date}', order.deliveryDate || '—');

          await sendWhatsAppMessage(customerPhone, confirmation, business.id);
          console.log('[ORDER] Created and confirmed:', order.id);

          notifyOwner(business, order).catch((err) => console.error('[FLOW] notifyOwner error:', err));
          sendPushNotification(business.id, order).catch(() => {});

          // Alerte risque client — fire-and-forget, ne bloque jamais la réponse HTTP
          ;(async () => {
            try {
              const [local, global] = await Promise.all([
                getLocalClientWarning(clientPhone, business.id),
                getGlobalClientRisk(clientPhone),
              ]);
              let alert: string | null = null;
              if (global.warn) {
                alert = `🔴 Attention — Nouvelle commande de ${order.customerName} (${clientPhone}).\nCe client a un historique de refus chez plusieurs marchands OrderFlow (${global.globalClientFaultReturns} refus sur ${global.globalScoredOrders} commandes).\nVérifie avant de confirmer.`;
              } else if (local) {
                alert = `⚠️ Nouvelle commande de ${order.customerName} (${clientPhone}).\nCe client a déjà annulé/refusé dans ta boutique (${local.clientFaultReturns} refus).\nReste vigilant.`;
              }
              if (alert) await sendWhatsAppMessageToMerchant(alert, business.id);
            } catch (err) {
              console.error('[risk] Warning check error:', err);
            }
          })();
          // Extraction structurée fire-and-forget (productCategory, wilaya, city, deliveryCompany)
          ;(async () => {
            try {
              const fields = await extractStructuredFields(order.product, order.address, order.rawMessage);
              const data: Record<string, unknown> = {};
              if (fields.productCategory) data.productCategory = fields.productCategory as ProductCategory;
              if (fields.wilaya)          data.wilaya          = fields.wilaya as MoroccanWilaya;
              if (fields.city)            data.city            = fields.city;
              if (fields.deliveryCompany) data.deliveryCompany = fields.deliveryCompany as DeliveryCompany;
              if (Object.keys(data).length > 0) {
                await prisma.order.update({ where: { id: order.id }, data });
                console.log('[structured] Fields saved for order:', order.id, fields);
              }
            } catch (err) {
              console.error('[structured] Extraction error for order:', order.id, err);
            }
          })();

          await markConversationProcessed(business.id, customerPhone);
        }
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

  // Auto-save merchant phone on first echo if not yet stored
  if (!business.ownerNotifyPhone && merchantPhone) {
    await prisma.business.update({
      where: { id: business.id },
      data: { ownerNotifyPhone: merchantPhone },
    });
    business.ownerNotifyPhone = merchantPhone;
    console.log('[AUTO] Saved merchant phone from echo:', merchantPhone);
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
    // message.to is the business number — look up the actual client from conversation history
    const lastClientMessage = await prisma.conversationMessage.findFirst({
      where: {
        businessId: business.id,
        role: 'client',
        processed: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    const resolvedCustomerPhone = lastClientMessage?.phone || customerPhone;

    console.log('[TRIGGER] Customer phone from last message:', resolvedCustomerPhone);
    console.log(`[TRIGGER] Commande confirmée detected from merchant! Customer phone: ${resolvedCustomerPhone}`);
    handleTrigger(business, resolvedCustomerPhone, content).catch((err) =>
      console.error('[webhook/ycloud/echo] handleTrigger error:', err)
    );
  }
}

export default router;
