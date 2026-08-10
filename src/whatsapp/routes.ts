import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { evolutionProvider, instanceNameFor } from './evolutionProvider.js';
import { stripForMatch } from '../utils/triggerMatch.js';

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


// Normalize EVOLUTION_API_URL: Railway stores it without protocol
const _EVO_RAW = (process.env.EVOLUTION_API_URL || '').trim();
const EVOLUTION_BASE_URL = _EVO_RAW.startsWith('http://') || _EVO_RAW.startsWith('https://')
  ? _EVO_RAW.replace(/\/$/, '')
  : `https://${_EVO_RAW.replace(/\/$/, '')}`;
console.log('[whatsapp/routes] evolution base URL:', EVOLUTION_BASE_URL);

// Normalized form of the Meta Ads pre-filled trigger message.
// Legacy single-trigger flow only — businesses with Automation rows never reach it.
// "Montrez-moi vos modèles dispo 💐" → "montrez moi vos modeles dispo"
const TRIGGER_NORMALIZED = 'montrezmoi vos modeles dispo';

// Sent on first contact when no automation trigger matched, so a customer who
// wrote something off-script still gets an answer instead of silence.
const FALLBACK_MESSAGE =
  'Bonjour et bienvenue ✨ Vous êtes intéressé par quel service ? Dites-moi et je vous envoie tout 😊';

// Delay before the very first reply to a new contact: 10–15 s. Jittered so the
// reply never feels like a cron job, but short enough that the lead is still
// looking at their phone when the opener lands.
const REPLY_DELAY_MS = 10_000;
const REPLY_JITTER_MS = 5_000;

// Pause between the two optional follow-up messages: 1–2 s.
const FOLLOWUP_GAP_MS = 1_000;
const FOLLOWUP_JITTER_MS = 1_000;

// Breathing room between the three blocks of the send sequence
// (opener → media → follow-ups). Applied only between blocks that actually send.
const STEP_DELAY_MS = 30_000;

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

// Show "typing…" (or "recording…") indicator before a message — non-critical,
// silently ignored if the Evolution instance doesn't support this endpoint.
async function sendTypingPresence(
  instanceName: string,
  phoneNumber: string,
  durationMs: number,
  presence: 'composing' | 'recording' = 'composing',
): Promise<void> {
  try {
    await fetch(`${EVOLUTION_BASE_URL}/chat/sendPresence/${instanceName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY! },
      body: JSON.stringify({ number: phoneNumber, options: { presence, delay: durationMs } }),
    });
  } catch {
    // Presence API is optional — never crash the flow if it fails
  }
}

// Send the full first-contact flow: bouquet gallery → welcome → question
async function sendWelcomeFlow(
  businessId: string,
  instanceName: string,
  senderPhone: string,
  flowConfig: FlowConfig,
): Promise<void> {
  const imageUrls: string[] =
    Array.isArray(flowConfig.imageUrls) && flowConfig.imageUrls.length > 0
      ? flowConfig.imageUrls
      : flowConfig.imageUrl ? [flowConfig.imageUrl] : [];

  for (let i = 0; i < imageUrls.length; i++) {
    await sendTypingPresence(instanceName, senderPhone, 2000);
    await evolutionProvider.sendImage(businessId, senderPhone, imageUrls[i]);
    if (i < imageUrls.length - 1) {
      // Brief gap so WhatsApp doesn't bundle sequential images
      await new Promise<void>(r => setTimeout(r, 500));
    }
  }

  if (flowConfig.welcomeMessage) {
    await sendTypingPresence(instanceName, senderPhone, 3000);
    await evolutionProvider.sendText(businessId, senderPhone, flowConfig.welcomeMessage);
  }

  if (flowConfig.question) {
    await sendTypingPresence(instanceName, senderPhone, 2000);
    await evolutionProvider.sendText(businessId, senderPhone, flowConfig.question);
  }
}

// ── Automation-driven first-contact flow ──────────────────────────────────────

// Structural shape of the fields we read off an Automation row — avoids coupling
// this module to the generated Prisma type.
interface AutomationRule {
  id: string;
  name: string;
  triggerMessage: string;
  welcomeMessage: string;
  photoUrls: string[];
  videoUrl?: string | null;
  videoUrls?: string[];
  documentUrls?: string[];
  message2?: string | null;
  message3?: string | null;
  audioUrl?: string | null;
}

/** Storage paths are "<timestamp>-<original name>" — recover the readable part
 *  so WhatsApp shows a real file name under the document tile. */
function documentNameFromUrl(url: string): string {
  const last = url.split('?')[0].split('/').pop() ?? '';
  let name = '';
  try {
    name = decodeURIComponent(last).replace(/^\d+-/, '');
  } catch {
    name = last.replace(/^\d+-/, '');
  }
  if (!name) return 'document.pdf';
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

// Returns the first automation whose normalized trigger is contained in the
// normalized incoming text. Caller passes them already sorted by priority DESC.
function matchAutomation<T extends AutomationRule>(
  automations: T[],
  incomingText: string,
): T | null {
  const incoming = stripForMatch(incomingText);
  if (!incoming) return null;

  for (const automation of automations) {
    const trigger = stripForMatch(automation.triggerMessage);
    // A blank trigger normalizes to '' and would match every message —
    // skip it rather than let it hijack the whole funnel.
    if (!trigger) continue;
    if (incoming.includes(trigger)) return automation;
  }
  return null;
}

// Three blocks: the opener script, then the media, then the optional follow-ups.
// STEP_DELAY_MS separates them — but only ever between two blocks that actually
// send, so a skipped block never leaves the customer waiting on silence.
// Every send stays awaited, so blocks never overlap and the 30 s waits start
// only once Evolution has accepted the previous block (video upload included).
async function sendAutomationFlow(
  businessId: string,
  instanceName: string,
  senderPhone: string,
  automation: AutomationRule,
): Promise<void> {
  const photoUrls = automation.photoUrls ?? [];
  const documentUrls = automation.documentUrls ?? [];

  // videoUrls is the source of truth; fall back to the legacy single field so a
  // row written before the backfill still sends its video.
  const videoUrls = automation.videoUrls?.length
    ? automation.videoUrls
    : automation.videoUrl ? [automation.videoUrl] : [];

  // Brief gap so WhatsApp doesn't bundle sequential media
  const gap = () => new Promise<void>(r => setTimeout(r, 500));
  const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  // Flips on the first thing sent, so the leading block never waits first
  let sentSomething = false;

  // ── 1. Opener ───────────────────────────────────────────────────────────
  if (automation.welcomeMessage) {
    await sendTypingPresence(instanceName, senderPhone, 3000);
    await evolutionProvider.sendText(businessId, senderPhone, automation.welcomeMessage);
    sentSomething = true;
  }

  // ── 2. Media — video, then PDFs, then photos ────────────────────────────
  if (videoUrls.length > 0 || documentUrls.length > 0 || photoUrls.length > 0) {
    if (sentSomething) await pause(STEP_DELAY_MS);

    for (let i = 0; i < videoUrls.length; i++) {
      await sendTypingPresence(instanceName, senderPhone, 2000);
      await evolutionProvider.sendVideo(businessId, senderPhone, videoUrls[i]);
      if (i < videoUrls.length - 1 || documentUrls.length > 0 || photoUrls.length > 0) {
        await gap();
      }
    }

    for (let i = 0; i < documentUrls.length; i++) {
      await sendTypingPresence(instanceName, senderPhone, 2000);
      await evolutionProvider.sendDocument(
        businessId,
        senderPhone,
        documentUrls[i],
        documentNameFromUrl(documentUrls[i]),
      );
      if (i < documentUrls.length - 1 || photoUrls.length > 0) await gap();
    }

    for (let i = 0; i < photoUrls.length; i++) {
      await sendTypingPresence(instanceName, senderPhone, 2000);
      await evolutionProvider.sendImage(businessId, senderPhone, photoUrls[i]);
      if (i < photoUrls.length - 1) await gap();
    }

    sentSomething = true;
  }

  // ── 3. Optional follow-ups ──────────────────────────────────────────────
  // Collected into a list rather than handled by two separate ifs: that way the
  // 30 s wait lands before the first follow-up actually sent. With two ifs, an
  // automation filling only message3 would fire it straight after the media.
  const followUps = [automation.message2, automation.message3]
    .map(m => m?.trim())
    .filter((m): m is string => !!m);
  const audioUrl = automation.audioUrl?.trim();

  if (followUps.length > 0 || audioUrl) {
    if (sentSomething) await pause(STEP_DELAY_MS);

    for (let i = 0; i < followUps.length; i++) {
      if (i > 0) {
        await pause(FOLLOWUP_GAP_MS + Math.floor(Math.random() * FOLLOWUP_JITTER_MS));
      }
      await sendTypingPresence(instanceName, senderPhone, 2000);
      await evolutionProvider.sendText(businessId, senderPhone, followUps[i]);
    }

    // Voice note last. "recording" rather than "composing" so the indicator
    // matches what is about to arrive.
    if (audioUrl) {
      if (followUps.length > 0) {
        await pause(FOLLOWUP_GAP_MS + Math.floor(Math.random() * FOLLOWUP_JITTER_MS));
      }
      await sendTypingPresence(instanceName, senderPhone, 3000, 'recording');
      await evolutionProvider.sendAudio(businessId, senderPhone, audioUrl);
    }
  }
}

// Runs only on the very first message of a conversation: match a trigger and
// fire its flow, or send the neutral fallback. Every later message is ignored
// so the merchant can take over the conversation by hand.
async function handleAutomationFirstContact(
  business: { id: string; whatsappConnected: boolean },
  instanceName: string,
  senderPhone: string,
  incomingText: string,
  automations: AutomationRule[],
): Promise<void> {
  // Never push into a disconnected instance. Nothing is consumed here, so the
  // flow still fires on the customer's next message once WhatsApp is back.
  if (!business.whatsappConnected) {
    console.log(`[automation] ${instanceName} not connected — skipping ${senderPhone}`);
    return;
  }

  // Atomic first-contact claim. P2002 means a session already exists: either a
  // follow-up message (human takes over) or a duplicate webhook delivery.
  try {
    await prisma.whatsappSession.create({
      data: { businessId: business.id, phoneNumber: senderPhone },
    });
  } catch (err) {
    if ((err as Record<string, unknown>).code === 'P2002') {
      console.log(`[automation] ${senderPhone} — not a first message, staying silent`);
      return;
    }
    throw err;
  }

  const matched = matchAutomation(automations, incomingText);

  console.log('[automation-match]', JSON.stringify({
    phone: senderPhone,
    normalized: stripForMatch(incomingText),
    matched: matched ? { id: matched.id, name: matched.name } : null,
    candidates: automations.length,
  }));

  const delay = REPLY_DELAY_MS + Math.floor(Math.random() * REPLY_JITTER_MS);
  const businessId = business.id;

  console.log(`[automation] scheduling reply in ${delay}ms for ${senderPhone}`);

  // Fire-and-forget: processWebhook returns immediately; the flow runs after the delay
  setTimeout(() => {
    const run = matched
      ? sendAutomationFlow(businessId, instanceName, senderPhone, matched)
      : evolutionProvider.sendText(businessId, senderPhone, FALLBACK_MESSAGE);

    run.catch(err => console.error(`[automation] send error for ${senderPhone}:`, err));
  }, delay);
}

async function processWebhook(instanceName: string, payload: Record<string, unknown>): Promise<void> {
  // Log every incoming webhook so we can see format + event name in Railway
  console.log('[webhook-raw]', JSON.stringify({
    instanceName,
    event: payload.event,
    dataIsArray: Array.isArray(payload.data),
    dataKeys: Array.isArray(payload.data)
      ? `array[${(payload.data as unknown[]).length}]`
      : Object.keys((payload.data ?? {}) as object).join(','),
  }));

  const business = await prisma.business.findFirst({
    where: { whatsappInstanceName: instanceName },
  });

  if (!business) {
    console.warn(`[webhook] Unknown instance: ${instanceName}`);
    return;
  }

  const event = (payload.event as string) ?? '';

  // Evolution v2 sends data as either a plain object OR an array of message objects.
  // Normalise to a single object so all downstream code is format-agnostic.
  const rawData = payload.data;
  const data = (Array.isArray(rawData) ? (rawData[0] ?? {}) : (rawData ?? {})) as Record<string, unknown>;

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

    // Broaden extraction to cover all known Evolution/Baileys payload variants
    const extendedText    = (message.extendedTextMessage as Record<string, unknown> | undefined) ?? {};
    const ephemeralInner  = ((message.ephemeralMessage as Record<string, unknown> | undefined)
                              ?.message as Record<string, unknown> | undefined) ?? {};
    const imageMsg        = (message.imageMessage as Record<string, unknown> | undefined) ?? {};

    const incomingText: string =
      (message.conversation as string | undefined) ||
      (extendedText.text as string | undefined) ||
      ((ephemeralInner.extendedTextMessage as Record<string, unknown> | undefined)?.text as string | undefined) ||
      (ephemeralInner.conversation as string | undefined) ||
      (imageMsg.caption as string | undefined) ||
      '';

    const rawText = incomingText.toLowerCase();

    // ── Automation-driven detection ───────────────────────────────────────
    // Configured from the dashboard, one row per Meta ad funnel. Highest
    // priority is tested first; the first trigger contained in the incoming
    // text wins and no other automation is tried.
    const automations = await prisma.automation.findMany({
      where: { businessId: business.id, isActive: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    if (automations.length > 0) {
      await handleAutomationFirstContact(
        business,
        instanceName,
        senderPhone,
        incomingText,
        automations,
      );
      return;
    }

    // ── Legacy single-trigger flow (fallback) ─────────────────────────────
    // Reached only while a business has zero active automations — this is what
    // keeps Zethnika's live funnel (photos → question → vous/cadeau branches)
    // running unchanged, since Automation cannot express its follow-up replies.

    // Ad-referral metadata present when WhatsApp routes the message via a Meta ad
    const contextInfo = (extendedText.contextInfo as Record<string, unknown> | undefined) ?? {};
    const adReferral =
      contextInfo.externalAdReply ||
      (message.contextInfo as Record<string, unknown> | undefined)?.externalAdReply ||
      null;

    // Encoding-proof match: strip accents/punctuation/case on both sides
    const normalizedIncoming = stripForMatch(incomingText);
    const textMatch = normalizedIncoming.includes(TRIGGER_NORMALIZED);
    const isFromAd  = textMatch || !!adReferral;

    console.log('[webhook-debug]', JSON.stringify({
      phone: senderPhone,
      incomingText,
      textMatch,
      hasAdReferral: !!adReferral,
      isFromAd,
    }));
    console.log('[webhook-debug-normalized]', {
      normalized: normalizedIncoming,
      trigger: TRIGGER_NORMALIZED,
      match: textMatch,
    });

    const flowConfig = business.whatsappFlowConfig as FlowConfig | null;
    if (!flowConfig?.enabled) return;

    if (isFromAd) {
      // Atomic session create — if P2002 (unique violation) a duplicate webhook
      // already created the session; skip silently to prevent double-sending.
      try {
        await prisma.whatsappSession.create({
          data: { businessId: business.id, phoneNumber: senderPhone },
        });
      } catch (err) {
        if ((err as Record<string, unknown>).code === 'P2002') {
          console.log(`[webhook] Duplicate webhook for ${senderPhone} — skipping (session already exists)`);
          return;
        }
        throw err;
      }

      // 60–75 s jitter so the reply never feels like a cron job
      const delay = 60_000 + Math.floor(Math.random() * 15_000);

      const businessId  = business.id;
      const flowSnapshot = { ...flowConfig } as FlowConfig;

      console.log('[webhook] scheduling welcome flow in', delay, 'ms for', senderPhone);

      // Fire-and-forget: processWebhook returns immediately; flow runs after delay
      setTimeout(() => {
        console.log('[webhook] NOW sending welcome flow to', senderPhone);
        sendWelcomeFlow(businessId, instanceName, senderPhone, flowSnapshot)
          .catch(err => console.error(`[webhook] Delayed welcome flow error for ${senderPhone}:`, err));
      }, delay);

    } else {
      // Check for vous/cadeau replies — only for contacts who came in via the ad
      const existingSession = await prisma.whatsappSession.findUnique({
        where: { phoneNumber_businessId: { phoneNumber: senderPhone, businessId: business.id } },
      });
      if (existingSession && rawText.includes('vous') && flowConfig.replyVous) {
        await evolutionProvider.sendText(business.id, senderPhone, flowConfig.replyVous);
      } else if (existingSession && rawText.includes('cadeau') && flowConfig.replyCadeau) {
        await evolutionProvider.sendText(business.id, senderPhone, flowConfig.replyCadeau);
      } else {
        console.log(`[webhook] ${senderPhone} — ignored (hasSession=${!!existingSession})`);
      }
    }
  }
}

// ── Public webhook — no auth, always returns 200 ──────────────────────────────

router.post('/webhook/:instanceName', async (req: Request, res: Response) => {
  // Respond immediately so Evolution does not retry
  res.status(200).json({ ok: true });

  const { instanceName } = req.params;
  const payload = req.body as Record<string, unknown>;

  // Log the full raw payload so we can debug Evolution format mismatches in Railway
  console.log('[webhook-incoming]', instanceName, JSON.stringify(payload).slice(0, 800));

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
    const evoBase = EVOLUTION_BASE_URL;
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

// POST /api/whatsapp/send-qr — send QR code image via WhatsApp to a recipient number
router.post('/send-qr', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { recipientNumber, qrBase64 } = req.body as { recipientNumber?: string; qrBase64?: string };
    if (!recipientNumber || !qrBase64) {
      res.status(400).json({ error: 'recipientNumber and qrBase64 are required' });
      return;
    }

    // Normalize Moroccan numbers: 06x/07x → 2126x/2127x, strip leading +
    let number = recipientNumber.trim().replace(/\s+/g, '');
    if (number.startsWith('0')) number = '212' + number.slice(1);
    else if (number.startsWith('+')) number = number.slice(1);
    if (!/^\d{10,15}$/.test(number)) {
      res.status(400).json({ error: 'Numéro de téléphone invalide' });
      return;
    }

    // Strip data URL prefix if present (e.g. "data:image/png;base64,...")
    const base64 = qrBase64.replace(/^data:image\/[a-z]+;base64,/, '');

    const name = instanceNameFor(req.user!.businessId);
    const evoBase = EVOLUTION_BASE_URL;
    const headers = { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY! };

    const evoRes = await fetch(`${evoBase}/message/sendMedia/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number,
        mediatype: 'image',
        mimetype: 'image/png',
        media: base64,
        caption: '📱 Scannez ce QR code dans WhatsApp → Appareils connectés → Lier un appareil',
      }),
    });

    if (!evoRes.ok) {
      const text = await evoRes.text();
      console.error('[whatsapp] send-qr Evolution error:', evoRes.status, text);
      res.status(500).json({ error: "Impossible d'envoyer le QR. Vérifiez que le numéro est sur WhatsApp." });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[whatsapp] send-qr error:', err);
    res.status(500).json({ error: "Impossible d'envoyer le QR" });
  }
});

// GET /api/whatsapp/status — { connected: boolean }
router.get('/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = await evolutionProvider.getStatus(req.user!.businessId);
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
