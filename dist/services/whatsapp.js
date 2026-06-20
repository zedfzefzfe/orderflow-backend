const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v18.0';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'nouvelle_commande';
export async function notifyOwner(business, order) {
    if (!business.ownerNotifyPhone || !business.whatsappPhoneNumberId) {
        console.log('No owner phone or phone number ID configured, skipping notification');
        return;
    }
    const body = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: business.ownerNotifyPhone,
        type: 'template',
        template: {
            name: TEMPLATE_NAME,
            language: { code: 'fr' },
            components: [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: order.customerName || 'Client' },
                        { type: 'text', text: order.product || 'Produit' },
                        { type: 'text', text: String(order.quantity || 1) },
                        { type: 'text', text: order.address || 'Non specifie' },
                        { type: 'text', text: order.deliveryDate || 'Non specifie' },
                    ],
                },
            ],
        },
    };
    try {
        const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${business.whatsappPhoneNumberId}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`WhatsApp notification failed: ${response.status} ${errorText}`);
        }
        else {
            console.log(`WhatsApp notification sent to ${business.ownerNotifyPhone}`);
        }
    }
    catch (err) {
        console.error('WhatsApp notification error:', err);
    }
}
export async function sendTextToOwner(business, text) {
    if (!business.ownerNotifyPhone || !business.whatsappPhoneNumberId) {
        console.log('[whatsapp] sendTextToOwner skipped — no owner phone or phone number ID');
        return;
    }
    const body = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: business.ownerNotifyPhone,
        type: 'text',
        text: { body: text },
    };
    try {
        const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${business.whatsappPhoneNumberId}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[whatsapp] sendTextToOwner failed: ${response.status} ${errorText}`);
        }
        else {
            console.log(`[whatsapp] Text sent to owner ${business.ownerNotifyPhone}`);
        }
    }
    catch (err) {
        console.error('[whatsapp] sendTextToOwner error:', err);
    }
}
//# sourceMappingURL=whatsapp.js.map