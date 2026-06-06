import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { parseOrderMessage } from '../services/llmParser.js';
import { notifyOwner } from '../services/whatsapp.js';
const router = Router();
// Meta webhook verification (GET)
router.get('/', (req, res) => {
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
// Incoming messages (POST) — handles Twilio, Meta, and YCloud payloads
router.post('/', (req, res) => {
    console.log('[webhook] POST received — raw payload:', JSON.stringify(req.body));
    // Twilio sends urlencoded with Body + From starting with "whatsapp:"
    if (typeof req.body.Body === 'string' && typeof req.body.From === 'string' && req.body.From.startsWith('whatsapp:')) {
        handleTwilioPayload(req, res).catch((err) => {
            console.error('[webhook/twilio] Processing error:', err);
            res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        });
        return;
    }
    // YCloud payload
    if (req.body.type === 'whatsapp.inbound_message.received' && req.body.whatsappInboundMessage) {
        res.status(200).json({ received: true });
        handleYCloudPayload(req.body).catch((err) => {
            console.error('[webhook/ycloud] Processing error:', err);
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
async function handleTwilioPayload(req, res) {
    const messageText = req.body.Body;
    const senderPhone = req.body.From.replace('whatsapp:', '');
    const senderName = req.body.ProfileName || null;
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
async function handleMetaPayload(body) {
    if (!body.object || !body.entry) {
        console.log('[webhook/meta] Payload has no object/entry — skipping');
        return;
    }
    const entries = body.entry;
    for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
            const value = change.value;
            if (!value?.messages)
                continue;
            const metadata = value.metadata;
            const phoneNumberId = metadata?.phone_number_id;
            const business = await prisma.business.findFirst({
                where: { whatsappPhoneNumberId: phoneNumberId },
            });
            if (!business) {
                console.log(`[webhook/meta] No business found for phoneNumberId: ${phoneNumberId}`);
                continue;
            }
            const messages = value.messages;
            for (const message of messages) {
                if (message.type !== 'text')
                    continue;
                const fromPhone = message.from;
                const textObj = message.text;
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
// --- YCloud handler (fire-and-forget) ---
async function handleYCloudPayload(body) {
    const msg = body.whatsappInboundMessage;
    if (msg.type !== 'text') {
        console.log('[webhook/ycloud] Skipping non-text message type:', msg.type);
        return;
    }
    const textObj = msg.text;
    const messageText = textObj?.body || '';
    const senderPhone = msg.from;
    const profile = msg.customerProfile;
    const senderName = profile?.name || null;
    const wabaId = msg.wabaId;
    console.log(`[webhook/ycloud] Message from ${senderPhone} (${senderName ?? 'no name'}): "${messageText}"`);
    const business = await prisma.business.findFirst({
        where: { whatsappBusinessAccountId: wabaId },
    });
    if (!business) {
        console.log(`[webhook/ycloud] No business found for wabaId: ${wabaId}`);
        return;
    }
    await prisma.messageLog.create({
        data: { businessId: business.id, fromPhone: senderPhone, body: messageText, parsed: false },
    });
    const parsed = await parseOrderMessage(messageText);
    console.log('[webhook/ycloud] Parsed result:', JSON.stringify(parsed));
    await processParsedOrder({ business, parsed, senderPhone, senderName, messageText, source: 'ycloud' });
}
// --- Shared order creation logic ---
async function processParsedOrder({ business, parsed, senderPhone, senderName, messageText, source, }) {
    if (!parsed.isOrder) {
        return 'Bonjour! Envoyez-nous votre commande et nous la traiterons rapidement. 😊';
    }
    const PLAN_LIMITS = { trial: 50, starter: 200, growth: -1, pro: -1 };
    const limit = PLAN_LIMITS[business.plan] ?? 50;
    if (limit !== -1) {
        const count = await prisma.order.count({ where: { businessId: business.id } });
        if (count >= limit) {
            console.log(`[webhook] Order blocked for "${business.name}" — plan limit (${count}/${limit})`);
            return 'Désolé, la limite de commandes du plan est atteinte.';
        }
    }
    // Auto-fill price from product catalog if not provided by customer
    let autoPrice = parsed.totalPrice;
    if (!autoPrice && parsed.product) {
        const catalogItem = await prisma.productCatalog.findFirst({
            where: {
                businessId: business.id,
                name: { equals: parsed.product, mode: 'insensitive' },
            },
        });
        if (catalogItem) {
            autoPrice = catalogItem.price * (parsed.quantity || 1);
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
            totalPrice: autoPrice,
            rawMessage: messageText,
            source,
        },
    });
    console.log(`[webhook] Order created: ${order.id} for business "${business.name}"`);
    await prisma.messageLog.updateMany({
        where: { businessId: business.id, fromPhone: senderPhone, body: messageText },
        data: { parsed: true },
    });
    notifyOwner(business, order).catch((err) => console.error('[webhook] Failed to notify owner:', err));
    return `Commande reçue ✅ ${buildOrderSummary(parsed)}`;
}
function buildOrderSummary(parsed) {
    const parts = [];
    if (parsed.product)
        parts.push(parsed.product);
    if (parsed.quantity && parsed.quantity > 1)
        parts.push(`x${parsed.quantity}`);
    if (parsed.address)
        parts.push(`→ ${parsed.address}`);
    if (parsed.deliveryDate)
        parts.push(`📅 ${parsed.deliveryDate}`);
    return parts.length ? parts.join(', ') : '';
}
export default router;
//# sourceMappingURL=webhook.js.map