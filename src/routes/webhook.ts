import { Router, Request, Response } from 'express';
import type { Business } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { parseOrderFromConversation } from '../services/llmParser.js';
import { notifyOwner, sendTextToOwner } from '../services/whatsapp.js';
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

function detectRole(senderPhone: string, business: Business): 'client' | 'merchant' {
  if (!business.ownerNotifyPhone) return 'client';
  const normalize = (p: string) => p.replace(/\D/g, '');
  return normalize(senderPhone) === normalize(business.ownerNotifyPhone) ? 'merchant' : 'client';
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

// ── Core trigger handler: collect conversation, parse, create order ────────────

async function handleTrigger(business: Business, customerPhone: string): Promise<void> {
  const totalCount = await prisma.conversationMessage.count({
    where: { businessId: business.id, phone: customerPhone },
  });

  const conversation = await prisma.conversationMessage.findMany({
    where: { businessId: business.id, phone: customerPhone, processed: false },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[CONVERSATION] Total messages for customer: ${totalCount}`);
  console.log(`[CONVERSATION] Unprocessed messages: ${conversation.length}`);
  console.log(`[CONVERSATION] Previous orders processed: ${totalCount - conversation.length}`);

  if (conversation.length === 0) {
    console.log(`[TRIGGER] No unprocessed messages found for ${customerPhone}`);
    console.log(`[TRIGGER] Customer may have already had their order processed`);
    return;
  }

  const formattedConversation = conversation
    .map((msg) => `[${msg.role.toUpperCase()}] (${msg.type}): ${msg.content}`)
    .join('\n');

  console.log(`[webhook/trigger] Parsing conversation for ${customerPhone} (${conversation.length} messages)`);

  // Fetch last order to resolve references like "même adresse" or "même chose"
  const lastOrder = await prisma.order.findFirst({
    where: { businessId: business.id, customerPhone },
    orderBy: { createdAt: 'desc' },
  });

  const contextNote = lastOrder
    ? `CONTEXTE - Dernière commande de ce client:\n- Nom: ${lastOrder.customerName}\n- Adresse: ${lastOrder.address || 'non renseignée'}\n- Téléphone: ${lastOrder.customerPhone}\n- Produit: ${lastOrder.product}\nSi le client dit "même adresse", "même chose" ou expression similaire → utilise les infos de la dernière commande.`
    : '';

  const parsed = await parseOrderFromConversation(formattedConversation, contextNote);
  console.log(`[webhook/trigger] Parsed result — confidence: ${parsed.confidence}, product: ${parsed.product}`);

  // Plan limit check
  const PLAN_LIMITS: Record<string, number> = { trial: 50, starter: 200, growth: -1, pro: -1 };
  const limit = PLAN_LIMITS[business.plan] ?? 50;
  if (limit !== -1) {
    const count = await prisma.order.count({ where: { businessId: business.id } });
    if (count >= limit) {
      console.log(`[webhook/trigger] Order blocked for "${business.name}" — plan limit (${count}/${limit})`);
      return;
    }
  }

  // Auto-fill price from catalog
  let autoPrice: number | null = parsed.price;
  if (!autoPrice && parsed.product) {
    const catalogItem = await prisma.productCatalog.findFirst({
      where: { businessId: business.id, name: { equals: parsed.product, mode: 'insensitive' } },
    });
    if (catalogItem) {
      autoPrice = catalogItem.price * (parsed.quantity || 1);
    }
  }

  const orderData = {
    businessId: business.id,
    customerName: parsed.customerName || 'Unknown',
    customerPhone,
    product: parsed.product || 'À préciser',
    quantity: parsed.quantity || 1,
    address: parsed.address || null,
    deliveryDate: parsed.deliveryDate || null,
    totalPrice: autoPrice,
    rawMessage: formattedConversation.slice(0, 5000),
    source: 'whatsapp',
  };

  const needsReview = !parsed.product || !parsed.address;
  const order = await prisma.order.create({ data: { ...orderData, needsReview } });
  console.log(`[ORDER] Created — id: ${order.id}, product: ${order.product}, needsReview: ${needsReview}`);
  notifyOwner(business, order).catch((err) => console.error('[webhook/trigger] notifyOwner error:', err));
  await markConversationProcessed(business.id, customerPhone);
}

async function markConversationProcessed(businessId: string, phone: string): Promise<void> {
  const { count } = await prisma.conversationMessage.updateMany({
    where: { businessId, phone, processed: false },
    data: { processed: true },
  });
  console.log(`[TRIGGER] Marked ${count} messages as processed for ${phone}`);
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

  // Twilio sends urlencoded with Body + From starting with "whatsapp:"
  if (typeof req.body.Body === 'string' && typeof req.body.From === 'string' && req.body.From.startsWith('whatsapp:')) {
    handleTwilioPayload(req, res).catch((err) => {
      console.error('[webhook/twilio] Processing error:', err);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });
    return;
  }

  // YCloud inbound (customer → business)
  if (req.body.type === 'whatsapp.inbound_message.received' && req.body.whatsappInboundMessage) {
    res.status(200).json({ received: true });
    handleYCloudPayload(req.body).catch((err) => {
      console.error('[webhook/ycloud] Processing error:', err);
    });
    return;
  }

  // YCloud echo (merchant → customer, sent from the business WhatsApp account)
  if (req.body.type === 'whatsapp.smb.message.echoes' && req.body.whatsappMessage) {
    res.status(200).json({ received: true });
    handleYCloudEcho(req.body).catch((err) => {
      console.error('[webhook/ycloud/echo] Processing error:', err);
    });
    return;
  }

  // Meta payload — acknowledge immediately (Meta requires response within 5s)
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

  // Determine message type and content
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

  // Detect trigger before saving so the trigger message is saved as processed=true
  const isTwilioTrigger = role === 'merchant' && type === 'text' && isTriggerMessage(content);
  await saveConversationMessage(business.id, customerPhone, role, type, content, mediaUrl0, isTwilioTrigger);

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: senderPhone, body: messageText || content, parsed: false },
  });

  if (isTwilioTrigger) {
    console.log(`[webhook/twilio] Trigger detected from merchant ${senderPhone} for customer ${customerPhone}`);
    handleTrigger(business, customerPhone).catch((err) =>
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
          handleTrigger(business, customerPhone).catch((err) =>
            console.error('[webhook/meta] handleTrigger error:', err)
          );
        }
      }
    }
  }
}

// ── YCloud handler ─────────────────────────────────────────────────────────────

async function handleYCloudPayload(body: Record<string, unknown>): Promise<void> {
  const msg = body.whatsappInboundMessage as Record<string, unknown>;
  const msgType = msg.type as string;
  const senderPhone = msg.from as string;
  const profile = msg.customerProfile as Record<string, string> | undefined;
  const wabaId = msg.wabaId as string | undefined;

  const business = await prisma.business.findFirst({
    where: { whatsappBusinessAccountId: wabaId },
  });

  if (!business) {
    console.log(`[webhook/ycloud] No business found for wabaId: ${wabaId}`);
    return;
  }

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
    // YCloud may use different field names depending on version — try all known variants
    mediaUrl = (audioObj?.url ?? audioObj?.link ?? audioObj?.cdnUrl ?? audioObj?.downloadUrl) as string | undefined;
    const mimeHint = (audioObj?.mimeType ?? audioObj?.mime_type ?? '') as string;
    console.log('[GROQ] yCloud audio URL:', mediaUrl ?? '(not found)');
    console.log('[GROQ] yCloud audio mime_type:', mimeHint || '(not provided)');
    if (mediaUrl) {
      console.log('[GROQ] Attempting to transcribe yCloud audio');
      // yCloud pre-signed URLs work without Authorization header
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

  const isYCloudTrigger = role === 'merchant' && type === 'text' && isTriggerMessage(content);
  await saveConversationMessage(business.id, customerPhone, role, type, content, mediaUrl, isYCloudTrigger);

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: senderPhone, body: content, parsed: false },
  });

  if (isYCloudTrigger) {
    console.log(`[webhook/ycloud] Trigger detected from merchant ${senderPhone} for customer ${customerPhone}`);
    handleTrigger(business, customerPhone).catch((err) =>
      console.error('[webhook/ycloud] handleTrigger error:', err)
    );
  }
}

// ── YCloud echo handler (merchant outbound messages) ──────────────────────────
// YCloud sends merchant's own messages as echo events so we can store them
// in conversation history and detect the "commande confirmée" trigger.
// Unlike inbound messages, we know the exact customer phone from `message.to`.

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

  // Determine content
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

  // Save with processed=true when it's the trigger so handleTrigger ignores it
  await saveConversationMessage(business.id, customerPhone, 'merchant', echoType, content, undefined, isEchoTrigger);

  await prisma.messageLog.create({
    data: { businessId: business.id, fromPhone: merchantPhone, body: content, parsed: false },
  }).catch(() => {/* non-critical */});

  if (isEchoTrigger) {
    console.log(`[TRIGGER] Commande confirmée detected from merchant! Customer phone: ${customerPhone}`);
    handleTrigger(business, customerPhone).catch((err) =>
      console.error('[webhook/ycloud/echo] handleTrigger error:', err)
    );
  }
}

export default router;
