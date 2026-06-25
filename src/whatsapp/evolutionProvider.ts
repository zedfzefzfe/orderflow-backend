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

// ── Abstraction interface ─────────────────────────────────────────────────────

export interface WhatsAppProvider {
  createInstance(businessId: string): Promise<{ qr: string | null }>;
  getQRCode(businessId: string): Promise<string | null>;
  getPairingCode(businessId: string, phoneNumber: string): Promise<string>;
  getStatus(businessId: string): Promise<{ connected: boolean }>;
  sendText(businessId: string, to: string, text: string): Promise<void>;
  sendImage(businessId: string, to: string, imageUrl: string, caption?: string): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function instanceNameFor(businessId: string): string {
  return `merchant_${businessId}`;
}

async function evoFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${EVOLUTION_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_KEY!,
      ...((options.headers ?? {}) as Record<string, string>),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[evolution] ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
    throw new Error(`Evolution API error ${res.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Evolution v2 implementation ───────────────────────────────────────────────

export const evolutionProvider: WhatsAppProvider = {
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
    }) as Record<string, unknown>;

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
      } catch (e) {
        console.warn(`[evolution] Webhook setup failed for ${name}:`, e);
      }
    }

    // Extract QR from create response — field varies by Evolution version
    const qrcode = data?.qrcode as Record<string, unknown> | undefined;
    const qr = (qrcode?.base64 ?? data?.base64 ?? null) as string | null;
    console.log(`[evolution] Instance created: ${name}`);
    return { qr };
  },

  async getQRCode(businessId) {
    const name = instanceNameFor(businessId);
    try {
      const data = await evoFetch(`/instance/connect/${name}`) as Record<string, unknown>;
      return (data?.base64 ?? null) as string | null;
    } catch {
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
    }) as Record<string, unknown>;

    const code = (data?.code ?? data?.pairingCode ?? '') as string;
    if (!code) throw new Error('No pairing code returned from Evolution API');
    return code;
  },

  async getStatus(businessId) {
    const name = instanceNameFor(businessId);
    try {
      const data = await evoFetch(`/instance/connectionState/${name}`) as Record<string, unknown>;
      const instance = data?.instance as Record<string, unknown> | undefined;
      const state = (instance?.state ?? data?.state ?? '') as string;
      return { connected: state === 'open' };
    } catch {
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
};
