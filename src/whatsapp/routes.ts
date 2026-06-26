import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { evolutionProvider, instanceNameFor } from './evolutionProvider.js';

const router = Router();

// ── First-contact tracker ─────────────────────────────────────────────────────
// In-memory map: instanceName → Set of sender phones that already received the
// welcome flow. Resets on server restart, which only means the welcome message
// re-triggers — acceptable for MVP. Upgrade path: replace with a DB table
// (e.g. whatsapp_contacted_senders) if persistence across restarts is needed.
const contactedSenders = new Map<string, Set<string>>();

function getContacted(instance: string): Set<string> {
  if (!contactedSenders.has(instance)) {
    contactedSenders.set(instance, new Set<string>());
  }
  return contactedSenders.get(instance)!;
}

// ── Webhook processor (extracted so the route can return 200 immediately) ─────

interface FlowConfig {
  enabled: boolean;
  imageUrl: string;
  welcomeMessage: string;
  question: string;
  replyVous: string;
  replyCadeau: string;
}

async function processWebhook(instanceName: string, payload: Record<string, unknown>): Promise<void> {
  const business = await prisma.business.findFirst({
    where: { whatsappInstanceName: instanceName },
  });

  if (!business) {
    console.warn(`[webhook] Unknown instance: ${instanceName}`);
    return;
  }

  const event = (payload.event as string) ?? '';
  const data = (payload.data ?? {}) as Record<string, unknown>;

  // ── CONNECTION_UPDATE ─────────────────────────────────────────────────────
  if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
    const state = (data.state as string) ?? '';
    const connected = state === 'open';
    await prisma.business.update({
      where: { id: business.id },
      data: { whatsappConnected: connected },
    });
    console.log(`[webhook] ${instanceName} connection state: ${state}`);
    return;
  }

  // ── MESSAGES_UPSERT ───────────────────────────────────────────────────────
  if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
    const key = (data.key ?? {}) as Record<string, unknown>;

    // Ignore messages we sent
    if (key.fromMe === true) return;

    const remoteJid = (key.remoteJid as string) ?? '';
    if (!remoteJid || remoteJid.endsWith('@g.us')) return; // skip group chats

    // Normalize: strip @s.whatsapp.net suffix
    const senderPhone = remoteJid.replace('@s.whatsapp.net', '');

    const message = (data.message ?? {}) as Record<string, unknown>;
    const extendedText = (message.extendedTextMessage ?? {}) as Record<string, unknown>;
    const rawText = (
      (message.conversation as string) ??
      (extendedText.text as string) ??
      ''
    ).toLowerCase();

    const flowConfig = business.whatsappFlowConfig as FlowConfig | null;
    if (!flowConfig?.enabled) return;

    const contacted = getContacted(instanceName);

    if (!contacted.has(senderPhone)) {
      // First inbound message from this sender — send the welcome flow
      contacted.add(senderPhone);

      if (flowConfig.imageUrl) {
        await evolutionProvider.sendImage(business.id, senderPhone, flowConfig.imageUrl);
      }
      if (flowConfig.welcomeMessage) {
        await evolutionProvider.sendText(business.id, senderPhone, flowConfig.welcomeMessage);
      }
      if (flowConfig.question) {
        await evolutionProvider.sendText(business.id, senderPhone, flowConfig.question);
      }
    } else if (rawText.includes('vous') && flowConfig.replyVous) {
      await evolutionProvider.sendText(business.id, senderPhone, flowConfig.replyVous);
    } else if (rawText.includes('cadeau') && flowConfig.replyCadeau) {
      await evolutionProvider.sendText(business.id, senderPhone, flowConfig.replyCadeau);
    }
  }
}

// ── Public webhook — no auth, always returns 200 ──────────────────────────────

router.post('/webhook/:instanceName', async (req: Request, res: Response) => {
  // Respond immediately so Evolution does not retry
  res.status(200).json({ ok: true });

  const { instanceName } = req.params;
  const payload = req.body as Record<string, unknown>;

  try {
    await processWebhook(instanceName, payload);
  } catch (err) {
    // Never let a webhook error crash the server or affect order processing
    console.error(`[webhook] Error processing ${instanceName}:`, err);
  }
});

// ── Auth-protected routes ─────────────────────────────────────────────────────

// POST /api/whatsapp/connect — create (or re-use) Evolution instance, return QR
router.post('/connect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const businessId = req.user!.businessId;
    const name = instanceNameFor(businessId);
    const webhookUrl = `${process.env.BACKEND_URL}/api/whatsapp/webhook/${name}`;

    // Attempt to create the instance; tolerate "already exists" errors so that
    // re-connecting an existing instance still reaches the setWebhook call below.
    let qr: string | null = null;
    try {
      const result = await evolutionProvider.createInstance(businessId);
      qr = result.qr;
    } catch (createErr) {
      const msg = String(createErr);
      if (!msg.includes('already') && !msg.includes('exists') && !msg.includes('409')) {
        throw createErr; // unexpected error — re-throw so the outer catch handles it
      }
      console.log(`[whatsapp] Instance ${name} already exists — skipping create, re-registering webhook`);
    }

    // Always (re-)register the webhook so Evolution knows our current URL
    if (process.env.BACKEND_URL) {
      await evolutionProvider.setWebhook(name, webhookUrl);
    } else {
      console.warn('[whatsapp] BACKEND_URL not set — webhook not registered');
    }

    await prisma.business.update({
      where: { id: businessId },
      data: {
        whatsappInstanceName: name,
        whatsappConnected: false,
      },
    });

    res.json({ qr });
  } catch (err) {
    console.error('[whatsapp] connect error:', err);
    res.status(500).json({ error: 'Failed to connect WhatsApp instance' });
  }
});

// GET /api/whatsapp/qr — current QR for polling/refresh while modal is open
router.get('/qr', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const qr = await evolutionProvider.getQRCode(req.user!.businessId);
    res.json({ qr });
  } catch (err) {
    console.error('[whatsapp] qr error:', err);
    res.status(500).json({ error: 'Failed to fetch QR code' });
  }
});

// POST /api/whatsapp/pairing-code — { phoneNumber } → { code }
router.post('/pairing-code', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { phoneNumber } = req.body as { phoneNumber?: string };
    if (!phoneNumber?.trim()) {
      res.status(400).json({ error: 'phoneNumber is required' });
      return;
    }
    const code = await evolutionProvider.getPairingCode(req.user!.businessId, phoneNumber.trim());
    res.json({ code });
  } catch (err) {
    console.error('[whatsapp] pairing-code error:', err);
    res.status(500).json({ error: 'Failed to get pairing code' });
  }
});

// GET /api/whatsapp/status — { connected: boolean }
router.get('/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = await evolutionProvider.getStatus(req.user!.businessId);
    // Keep DB in sync with live Evolution state
    await prisma.business.update({
      where: { id: req.user!.businessId },
      data: { whatsappConnected: status.connected },
    });
    res.json(status);
  } catch (err) {
    console.error('[whatsapp] status error:', err);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// GET /api/whatsapp/flow — return saved welcome-flow config
router.get('/flow', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user!.businessId },
      select: { whatsappFlowConfig: true },
    });
    const defaultConfig: FlowConfig = {
      enabled: false,
      imageUrl: '',
      welcomeMessage: '',
      question: "C'est pour vous ou un cadeau ? 🌸",
      replyVous: '',
      replyCadeau: '',
    };
    res.json(business?.whatsappFlowConfig ?? defaultConfig);
  } catch (err) {
    console.error('[whatsapp] flow GET error:', err);
    res.status(500).json({ error: 'Failed to fetch flow config' });
  }
});

// POST /api/whatsapp/set-webhook — manually re-register webhook without reconnecting
router.post('/set-webhook', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!process.env.BACKEND_URL) {
      res.status(500).json({ error: 'BACKEND_URL is not configured on the server' });
      return;
    }
    const name = instanceNameFor(req.user!.businessId);
    const webhookUrl = `${process.env.BACKEND_URL}/api/whatsapp/webhook/${name}`;
    await evolutionProvider.setWebhook(name, webhookUrl);
    res.json({ success: true, webhookUrl });
  } catch (err) {
    console.error('[whatsapp] set-webhook error:', err);
    res.status(500).json({ error: 'Failed to register webhook' });
  }
});

// PUT /api/whatsapp/flow — save welcome-flow config
router.put('/flow', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { enabled, imageUrl, welcomeMessage, question, replyVous, replyCadeau } =
      req.body as Partial<FlowConfig>;

    const config: FlowConfig = {
      enabled: Boolean(enabled),
      imageUrl: String(imageUrl ?? ''),
      welcomeMessage: String(welcomeMessage ?? ''),
      question: String(question ?? ''),
      replyVous: String(replyVous ?? ''),
      replyCadeau: String(replyCadeau ?? ''),
    };

    await prisma.business.update({
      where: { id: req.user!.businessId },
      // JSON round-trip satisfies Prisma's InputJsonValue constraint on Json fields
      data: { whatsappFlowConfig: JSON.parse(JSON.stringify(config)) },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[whatsapp] flow PUT error:', err);
    res.status(500).json({ error: 'Failed to save flow config' });
  }
});

export default router;
