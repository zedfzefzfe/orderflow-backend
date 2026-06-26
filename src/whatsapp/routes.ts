import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { evolutionProvider, instanceNameFor } from './evolutionProvider.js';

// ── Image upload config ───────────────────────────────────────────────────────

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const BUCKET = 'whatsapp-bouquets';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('TYPE_ERROR'));
    }
  },
});

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
  imageUrl?: string;    // legacy single-image field — kept for backward compat reads
  imageUrls?: string[]; // new multi-image array
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

      // Resolve image list — support new array format and legacy single-url
      const imageUrls: string[] =
        Array.isArray(flowConfig.imageUrls) && flowConfig.imageUrls.length > 0
          ? flowConfig.imageUrls
          : flowConfig.imageUrl ? [flowConfig.imageUrl] : [];

      for (let i = 0; i < imageUrls.length; i++) {
        await evolutionProvider.sendImage(business.id, senderPhone, imageUrls[i]);
        if (i < imageUrls.length - 1) {
          // 500 ms gap so WhatsApp doesn't bundle or rate-limit sequential images
          await new Promise<void>(r => setTimeout(r, 500));
        }
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

    // Always (re-)register the webhook so Evolution knows our current URL.
    // updateWebhook tries multiple paths to handle version differences.
    if (process.env.BACKEND_URL) {
      await evolutionProvider.updateWebhook(name, webhookUrl);
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
      res.status(400).json({ error: 'Numéro de téléphone requis' });
      return;
    }

    // Normalize: keep digits only (strips spaces, dashes, parentheses, leading +)
    const normalized = phoneNumber.replace(/\D/g, '');
    if (normalized.length < 7) {
      res.status(400).json({ error: 'Numéro de téléphone invalide' });
      return;
    }

    const businessId = req.user!.businessId;

    // Ensure the Evolution instance exists before requesting a pairing code.
    // It may not exist yet if the user skipped the QR tab or if POST /connect
    // failed silently. Create it now if needed, then wait for it to initialize.
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { whatsappInstanceName: true },
    });

    if (!business?.whatsappInstanceName) {
      const name = instanceNameFor(businessId);
      const webhookUrl = process.env.BACKEND_URL
        ? `${process.env.BACKEND_URL}/api/whatsapp/webhook/${name}`
        : '';

      try {
        await evolutionProvider.createInstance(businessId);
      } catch (createErr) {
        const msg = String(createErr);
        if (!msg.includes('already') && !msg.includes('exists') && !msg.includes('409')) {
          throw createErr;
        }
        console.log(`[whatsapp] pairing-code: instance ${name} already exists`);
      }

      // Give Evolution time to initialize the session before requesting a pairing code
      await new Promise<void>(r => setTimeout(r, 1500));

      if (webhookUrl) {
        await evolutionProvider.updateWebhook(name, webhookUrl);
      }

      await prisma.business.update({
        where: { id: businessId },
        data: { whatsappInstanceName: name, whatsappConnected: false },
      });
    }

    const code = await evolutionProvider.getPairingCode(businessId, normalized);
    res.json({ code });
  } catch (err) {
    console.error('[whatsapp] pairing-code error:', err);
    res.status(500).json({ error: 'Impossible de générer le code de liaison. Vérifiez le numéro et réessayez.' });
  }
});

// DELETE /api/whatsapp/disconnect — logout + delete Evolution instance, clear DB
router.delete('/disconnect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const businessId = req.user!.businessId;
    const name = instanceNameFor(businessId);
    const evoBase = process.env.EVOLUTION_API_URL!;
    const headers = { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY! };

    // Logout session — ignore errors (instance may already be logged out or not exist)
    await fetch(`${evoBase}/instance/logout/${name}`, { method: 'DELETE', headers })
      .catch(err => console.warn('[whatsapp] logout error (ignored):', err));

    // Delete instance from Evolution — ignore errors
    await fetch(`${evoBase}/instance/delete/${name}`, { method: 'DELETE', headers })
      .catch(err => console.warn('[whatsapp] delete instance error (ignored):', err));

    await prisma.business.update({
      where: { id: businessId },
      data: { whatsappConnected: false, whatsappInstanceName: null },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[whatsapp] disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp instance' });
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
      imageUrls: [],
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

// POST /api/whatsapp/upload-image — upload bouquet photo to Supabase Storage
router.post(
  '/upload-image',
  requireAuth,
  (req: AuthenticatedRequest, res: Response, next) => {
    upload.single('image')(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Fichier trop volumineux (max 5 Mo)' });
        return;
      }
      if (err instanceof Error && err.message === 'TYPE_ERROR') {
        res.status(400).json({ error: 'Type de fichier non accepté (jpeg, png, webp, gif uniquement)' });
        return;
      }
      if (err) {
        res.status(400).json({ error: 'Erreur lors de la réception du fichier' });
        return;
      }
      next();
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Aucun fichier reçu' });
        return;
      }

      const { businessId } = req.user!;
      const { buffer, mimetype, originalname } = req.file;
      const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${businessId}/${Date.now()}-${safeName}`;

      // Ensure the bucket exists (creates silently if already present)
      await supabaseAdmin.storage.createBucket(BUCKET, { public: true }).catch(() => {});

      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: mimetype, upsert: false });

      if (uploadError) {
        console.error('[whatsapp] Supabase upload error:', uploadError);
        res.status(500).json({ error: 'Échec du téléversement vers Supabase Storage' });
        return;
      }

      const { data: { publicUrl } } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
      res.json({ url: publicUrl });
    } catch (err) {
      console.error('[whatsapp] upload-image error:', err);
      res.status(500).json({ error: 'Erreur interne lors du téléversement' });
    }
  },
);

// POST /api/whatsapp/set-webhook — manually re-register webhook without reconnecting
router.post('/set-webhook', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!process.env.BACKEND_URL) {
      res.status(500).json({ error: 'BACKEND_URL is not configured on the server' });
      return;
    }
    const name = instanceNameFor(req.user!.businessId);
    const webhookUrl = `${process.env.BACKEND_URL}/api/whatsapp/webhook/${name}`;
    await evolutionProvider.updateWebhook(name, webhookUrl);
    res.json({ success: true, webhookUrl });
  } catch (err) {
    console.error('[whatsapp] set-webhook error:', err);
    res.status(500).json({ error: 'Failed to register webhook' });
  }
});

// PUT /api/whatsapp/flow — save welcome-flow config
router.put('/flow', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { enabled, imageUrl, imageUrls: rawImageUrls, welcomeMessage, question, replyVous, replyCadeau } =
      req.body as Partial<FlowConfig>;

    // Normalize to array — accept new imageUrls array or legacy imageUrl string
    const imageUrls = Array.isArray(rawImageUrls)
      ? rawImageUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : imageUrl ? [String(imageUrl)] : [];

    const config: FlowConfig = {
      enabled: Boolean(enabled),
      imageUrls,
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
