// ── Evolution API provider ────────────────────────────────────────────────────
// All calls to the Evolution v2 REST API live here. Swap this file to change
// the underlying WhatsApp provider without touching routes or webhook logic.
const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
if (!EVOLUTION_URL || !EVOLUTION_KEY) {
    const missing = [
        !EVOLUTION_URL && 'EVOLUTION_API_URL',
        !EVOLUTION_KEY && 'EVOLUTION_API_KEY',
    ].filter(Boolean).join(', ');
    console.error(`[FATAL] Missing required environment variables: ${missing}`);
    process.exit(1);
}
const BACKEND_URL = process.env.BACKEND_URL;
if (!BACKEND_URL) {
    console.warn('[whatsapp] BACKEND_URL is not set — Evolution webhook callbacks will not be registered');
}
// ── Helpers ───────────────────────────────────────────────────────────────────
export function instanceNameFor(businessId) {
    return `merchant_${businessId}`;
}
async function evoFetch(path, options = {}) {
    const url = `${EVOLUTION_URL}${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            apikey: EVOLUTION_KEY,
            ...(options.headers ?? {}),
        },
    });
    const text = await res.text();
    if (!res.ok) {
        console.error(`[evolution] ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
        throw new Error(`Evolution API error ${res.status}: ${text}`);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
// ── Evolution v2 implementation ───────────────────────────────────────────────
export const evolutionProvider = {
    async createInstance(businessId) {
        const name = instanceNameFor(businessId);
        // POST /instance/create — creates the Baileys instance
        const data = await evoFetch('/instance/create', {
            method: 'POST',
            body: JSON.stringify({
                instanceName: name,
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS',
            }),
        });
        // Register webhook separately (more reliable than embedding in create body)
        // Spec note: Evolution v2 uses PUT /webhook/set/:instanceName
        if (BACKEND_URL) {
            try {
                await evoFetch(`/webhook/set/${name}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        url: `${BACKEND_URL}/api/whatsapp/webhook/${name}`,
                        webhook_by_events: false,
                        webhook_base64: false,
                        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
                    }),
                });
                console.log(`[evolution] Webhook registered for ${name}`);
            }
            catch (e) {
                console.warn(`[evolution] Webhook setup failed for ${name}:`, e);
            }
        }
        // Extract QR from create response — field varies by Evolution version
        const qrcode = data?.qrcode;
        const qr = (qrcode?.base64 ?? data?.base64 ?? null);
        console.log(`[evolution] Instance created: ${name}`);
        return { qr };
    },
    async getQRCode(businessId) {
        const name = instanceNameFor(businessId);
        try {
            const data = await evoFetch(`/instance/connect/${name}`);
            return (data?.base64 ?? null);
        }
        catch {
            return null;
        }
    },
    async getPairingCode(businessId, phoneNumber) {
        const name = instanceNameFor(businessId);
        // Evolution v2: POST /instance/pairingCode/:instanceName with { number }
        // (differs from spec which suggested GET with ?number= query param)
        const data = await evoFetch(`/instance/pairingCode/${name}`, {
            method: 'POST',
            body: JSON.stringify({ number: phoneNumber }),
        });
        const code = (data?.code ?? data?.pairingCode ?? '');
        if (!code)
            throw new Error('No pairing code returned from Evolution API');
        return code;
    },
    async getStatus(businessId) {
        const name = instanceNameFor(businessId);
        try {
            const data = await evoFetch(`/instance/connectionState/${name}`);
            const instance = data?.instance;
            const state = (instance?.state ?? data?.state ?? '');
            return { connected: state === 'open' };
        }
        catch {
            return { connected: false };
        }
    },
    async sendText(businessId, to, text) {
        const name = instanceNameFor(businessId);
        await evoFetch(`/message/sendText/${name}`, {
            method: 'POST',
            body: JSON.stringify({ number: to, text }),
        });
    },
    async sendImage(businessId, to, imageUrl, caption) {
        const name = instanceNameFor(businessId);
        await evoFetch(`/message/sendMedia/${name}`, {
            method: 'POST',
            body: JSON.stringify({
                number: to,
                mediatype: 'image',
                mimetype: 'image/jpeg',
                media: imageUrl,
                caption: caption ?? '',
            }),
        });
    },
    async setWebhook(instanceName, webhookUrl) {
        await evoFetch(`/webhook/set/${instanceName}`, {
            method: 'PUT',
            body: JSON.stringify({
                webhook: {
                    enabled: true,
                    url: webhookUrl,
                    webhookByEvents: false,
                    webhookBase64: false,
                    events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
                },
            }),
        });
        console.log(`[evolution] Webhook set for ${instanceName} → ${webhookUrl}`);
    },
};
//# sourceMappingURL=evolutionProvider.js.map