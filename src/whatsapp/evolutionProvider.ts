// ── Evolution API provider ────────────────────────────────────────────────────
// All calls to the Evolution v2 REST API live here. Swap this file to change
// the underlying WhatsApp provider without touching routes or webhook logic.

const RAW = (process.env.EVOLUTION_API_URL || '').trim();
const EVOLUTION_BASE_URL = RAW.startsWith('http://') || RAW.startsWith('https://')
  ? RAW.replace(/\/$/, '')
  : `https://${RAW.replace(/\/$/, '')}`;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;

if (!RAW || !EVOLUTION_KEY) {
  const missing = [
    !RAW && 'EVOLUTION_API_URL',
    !EVOLUTION_KEY && 'EVOLUTION_API_KEY',
  ].filter(Boolean).join(', ');
  console.error(`[FATAL] Missing required environment variables: ${missing}`);
  process.exit(1);
}

console.log('[evolution] base URL:', EVOLUTION_BASE_URL);

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
  sendVideo(businessId: string, to: string, videoUrl: string, caption?: string): Promise<void>;
  sendDocument(businessId: string, to: string, documentUrl: string, fileName: string): Promise<void>;
  /** Sends as a WhatsApp voice note (the waveform bubble), not a file attachment. */
  sendAudio(businessId: string, to: string, audioUrl: string): Promise<void>;
  /** Register or update the Evolution webhook for an already-known instanceName. */
  setWebhook(instanceName: string, webhookUrl: string): Promise<void>;
  /** Try multiple paths to register the webhook, logging which one succeeds. */
  updateWebhook(instanceName: string, webhookUrl: string): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function instanceNameFor(businessId: string): string {
  return `merchant_${businessId}`;
}

async function evoFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${EVOLUTION_BASE_URL}${path}`;
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

// Shared webhook body used by setWebhook, updateWebhook, and createInstance
function webhookBody(webhookUrl: string): string {
  return JSON.stringify({
    webhook: {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    },
  });
}

// ── Evolution v2 implementation ───────────────────────────────────────────────

export const evolutionProvider: WhatsAppProvider = {
  async createInstance(businessId) {
    const name = instanceNameFor(businessId);

    // Include webhook config in the create body so it is set atomically,
    // even if the separate setWebhook call below fails or the path differs.
    const createBody: Record<string, unknown> = {
      instanceName: name,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    };
    if (BACKEND_URL) {
      createBody.webhook = {
        enabled: true,
        url: `${BACKEND_URL}/api/whatsapp/webhook/${name}`,
        webhookByEvents: false,
        webhookBase64: false,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      };
    }

    const data = await evoFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify(createBody),
    }) as Record<string, unknown>;

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

    const candidates: Array<() => Promise<unknown>> = [
      () => {
        console.log(`[evolution] getPairingCode: trying POST /instance/pairing-code/${name}`);
        return evoFetch(`/instance/pairing-code/${name}`, {
          method: 'POST',
          body: JSON.stringify({ number: phoneNumber }),
        });
      },
      () => {
        console.log(`[evolution] getPairingCode: trying POST /instance/connect/${name} with number`);
        return evoFetch(`/instance/connect/${name}`, {
          method: 'POST',
          body: JSON.stringify({ number: phoneNumber }),
        });
      },
      () => {
        console.log(`[evolution] getPairingCode: trying GET /instance/connect/${name}?number=${phoneNumber}`);
        return evoFetch(`/instance/connect/${name}?number=${encodeURIComponent(phoneNumber)}`);
      },
    ];

    for (const attempt of candidates) {
      try {
        const data = await attempt() as Record<string, unknown>;
        const code = (data?.code ?? data?.pairingCode ?? '') as string;
        if (code) {
          console.log(`[evolution] getPairingCode: success, code received`);
          return code;
        }
        // Response was 2xx but no code field — try next candidate
        console.warn(`[evolution] getPairingCode: 2xx but no code field in response, trying next`);
      } catch (err) {
        if (String(err).includes('404')) {
          console.warn(`[evolution] getPairingCode: 404, trying next path`);
          continue;
        }
        throw err; // non-404 error — stop immediately
      }
    }

    throw new Error(`[evolution] getPairingCode: all candidate paths failed for instance ${name}`);
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

  async sendVideo(businessId, to, videoUrl, caption) {
    const name = instanceNameFor(businessId);
    await evoFetch(`/message/sendMedia/${name}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        mediatype: 'video',
        mimetype: 'video/mp4',
        media: videoUrl,
        caption: caption ?? '',
      }),
    });
  },

  // fileName is what WhatsApp shows under the document tile — without it the
  // customer sees a meaningless generated name
  async sendDocument(businessId, to, documentUrl, fileName) {
    const name = instanceNameFor(businessId);
    await evoFetch(`/message/sendMedia/${name}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: documentUrl,
        fileName,
      }),
    });
  },

  // sendWhatsAppAudio (not sendMedia) is what makes WhatsApp render a real voice
  // note. encoding:true asks Evolution to transcode to OGG/Opus, so an MP3 or
  // M4A upload still arrives playable rather than as a file attachment.
  async sendAudio(businessId, to, audioUrl) {
    const name = instanceNameFor(businessId);
    await evoFetch(`/message/sendWhatsAppAudio/${name}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        audio: audioUrl,
        encoding: true,
      }),
    });
  },

  // POST /webhook/set/:instanceName — correct method for Evolution v2.3.7
  async setWebhook(instanceName, webhookUrl) {
    await evoFetch(`/webhook/set/${instanceName}`, {
      method: 'POST',
      body: webhookBody(webhookUrl),
    });
    console.log(`[evolution] Webhook set for ${instanceName} → ${webhookUrl}`);
  },

  // Tries three known Evolution webhook paths in order, logs which one works.
  // Useful when the exact path varies across self-hosted Evolution versions.
  async updateWebhook(instanceName, webhookUrl) {
    const candidates = [
      { method: 'POST', path: `/webhook/set/${instanceName}` },
      { method: 'PUT',  path: `/webhook/instance/set/${instanceName}` },
      { method: 'PATCH', path: `/webhook/${instanceName}` },
    ];

    for (const { method, path } of candidates) {
      try {
        await evoFetch(path, { method, body: webhookBody(webhookUrl) });
        console.log(`[evolution] updateWebhook succeeded: ${method} ${path} → ${webhookUrl}`);
        return;
      } catch (err) {
        if (String(err).includes('404')) {
          console.warn(`[evolution] ${method} ${path} → 404, trying next path...`);
          continue;
        }
        // Non-404 error (auth failure, network error, etc.) — stop immediately
        throw err;
      }
    }

    throw new Error(
      `[evolution] updateWebhook: all candidate paths returned 404 for instance ${instanceName}`,
    );
  },
};
