import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();
const MODEL = 'claude-haiku-4-5-20251001';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// In-memory rate limiting: 20 messages per user per hour
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): { allowed: boolean; minutesLeft?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(userId, { count: 1, resetAt: now + 3_600_000 });
    return { allowed: true };
  }
  if (entry.count >= 20) {
    const minutesLeft = Math.ceil((entry.resetAt - now) / 60_000);
    return { allowed: false, minutesLeft };
  }
  entry.count += 1;
  return { allowed: true };
}

async function buildContext(businessId: string) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const twoHoursAgo = new Date(now.getTime() - 7_200_000);

  const [
    business,
    todayOrders,
    thisMonthOrders,
    topProducts,
    topClients,
    topCities,
    recentOrders,
    catalog,
    pendingOrders,
  ] = await Promise.all([
    prisma.business.findUnique({ where: { id: businessId } }),
    prisma.order.findMany({ where: { businessId, createdAt: { gte: todayStart } } }),
    prisma.order.findMany({ where: { businessId, createdAt: { gte: monthStart } } }),
    prisma.order.groupBy({
      by: ['product'],
      where: { businessId, NOT: [{ product: '' }, { product: 'Unspecified' }] },
      _count: { product: true },
      orderBy: { _count: { product: 'desc' } },
      take: 5,
    }),
    prisma.order.groupBy({
      by: ['customerPhone', 'customerName'],
      where: { businessId },
      _count: { id: true },
      _sum: { totalPrice: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
    prisma.order.groupBy({
      by: ['address'],
      where: { businessId, NOT: { address: null }, address: { not: '' } },
      _count: { address: true },
      orderBy: { _count: { address: 'desc' } },
      take: 5,
    }),
    prisma.order.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        customerName: true,
        product: true,
        quantity: true,
        address: true,
        totalPrice: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.productCatalog.findMany({ where: { businessId } }),
    prisma.order.findMany({
      where: { businessId, status: 'NEW', createdAt: { lt: twoHoursAgo } },
      select: { customerName: true, product: true, createdAt: true },
    }),
  ]);

  const todayRevenue = todayOrders.reduce((s, o) => s + (o.totalPrice ?? 0), 0);
  const monthRevenue = thisMonthOrders.reduce((s, o) => s + (o.totalPrice ?? 0), 0);
  const confirmedThisMonth = thisMonthOrders.filter(
    o => o.status === 'CONFIRMED' || o.status === 'DELIVERED',
  ).length;

  return {
    businessName: business?.name ?? 'Votre boutique',
    today: {
      orders: todayOrders.length,
      revenue: todayRevenue,
      newOrders: todayOrders.filter(o => o.status === 'NEW').length,
      confirmedOrders: todayOrders.filter(o => o.status === 'CONFIRMED').length,
      deliveredOrders: todayOrders.filter(o => o.status === 'DELIVERED').length,
      cancelledOrders: todayOrders.filter(o => o.status === 'CANCELLED').length,
      pendingOver2h: pendingOrders.length,
    },
    thisMonth: {
      totalOrders: thisMonthOrders.length,
      totalRevenue: monthRevenue,
      averageOrderValue: confirmedThisMonth > 0 ? Math.round(monthRevenue / confirmedThisMonth) : 0,
      confirmationRate:
        thisMonthOrders.length > 0
          ? Math.round((confirmedThisMonth / thisMonthOrders.length) * 100)
          : 0,
    },
    topProducts: topProducts.map(p => ({ product: p.product, count: p._count.product })),
    topClients: topClients.map(c => ({
      name: c.customerName,
      phone: c.customerPhone,
      count: c._count.id,
      revenue: c._sum.totalPrice ?? 0,
    })),
    topCities: topCities.filter(c => c.address).map(c => ({ city: c.address, count: c._count.address })),
    recentOrders: recentOrders.map(o => ({
      customerName: o.customerName,
      product: o.product,
      quantity: o.quantity,
      address: o.address,
      totalPrice: o.totalPrice,
      status: o.status,
      createdAt: o.createdAt,
    })),
    catalog: catalog.map(p => ({ name: p.name, price: p.price })),
    pendingOrders: pendingOrders.map(o => ({
      customerName: o.customerName,
      product: o.product,
      createdAt: o.createdAt,
    })),
  };
}

// POST /api/agent/chat
router.post('/chat', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.id;
  const businessId = req.user!.businessId;

  const rl = checkRateLimit(userId);
  if (!rl.allowed) {
    res.status(429).json({
      error: `Vous avez atteint la limite de 20 questions par heure. Réessayez dans ${rl.minutesLeft} minutes.`,
    });
    return;
  }

  try {
    const { message, conversationHistory = [] } = req.body as {
      message: string;
      conversationHistory: { role: 'user' | 'assistant'; content: string }[];
    };

    if (!message?.trim()) {
      res.status(400).json({ error: 'Message requis' });
      return;
    }

    const context = await buildContext(businessId);

    const systemPrompt = `Tu es l'agent IA personnel de ${context.businessName} sur OrderFlow.
Tu connais toutes les données de cette boutique en temps réel.
Tu réponds en français simple et chaleureux, comme un conseiller business de confiance. Tu es direct, précis, et encourageant.
Tu utilises les vraies données fournies pour répondre.
Tu ne réponds PAS aux questions hors du contexte business.
Si on te demande quelque chose que tu ne peux pas calculer avec les données disponibles, dis-le honnêtement.

DONNÉES EN TEMPS RÉEL DE LA BOUTIQUE:
${JSON.stringify(context, null, 2)}

FORMAT DE RÉPONSE:
- Maximum 3-4 phrases par réponse
- Utilise des chiffres précis quand disponibles
- Termine par une suggestion actionnable si pertinent
- Si c'est urgent (commandes en attente), commence par l'urgence
- À la fin de ta réponse, sur une nouvelle ligne, ajoute exactement:
SUGGESTED_QUESTIONS:["question1","question2","question3"]
Ces 3 questions doivent être pertinentes au contexte de la conversation.`;

    const messages = [
      ...conversationHistory.slice(-10),
      { role: 'user' as const, content: message },
    ];

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages,
    });

    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Non-text response');

    let reply = content.text;
    let suggestedQuestions: string[] = [];
    const sqMatch = content.text.match(/\nSUGGESTED_QUESTIONS:\s*(\[[\s\S]*?\])\s*$/);
    if (sqMatch) {
      try {
        suggestedQuestions = JSON.parse(sqMatch[1]);
        reply = content.text.slice(0, content.text.length - sqMatch[0].length).trim();
      } catch { /* keep full text if parse fails */ }
    }

    res.json({ reply, suggestedQuestions });
  } catch (err) {
    console.error('[agent/chat] error:', err);
    res.status(500).json({ error: "Désolé, une erreur s'est produite. Réessayez dans quelques secondes." });
  }
});

interface Alert {
  id: string;
  type: 'urgent' | 'warning' | 'info' | 'success';
  message: string;
  action?: string;
  actionRoute?: string;
}

// GET /api/agent/alerts
router.get('/alerts', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 7_200_000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3_600_000);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);

    const [
      pendingOrders,
      todayOrders,
      weekOrders,
      topClientGroup,
      last30Count,
      last30RevenueAgg,
    ] = await Promise.all([
      prisma.order.findMany({ where: { businessId, status: 'NEW', createdAt: { lt: twoHoursAgo } } }),
      prisma.order.findMany({ where: { businessId, createdAt: { gte: todayStart } } }),
      prisma.order.findMany({ where: { businessId, createdAt: { gte: weekStart } } }),
      prisma.order.groupBy({
        by: ['customerPhone', 'customerName'],
        where: { businessId },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 1,
      }),
      prisma.order.count({ where: { businessId, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.order.aggregate({
        where: { businessId, createdAt: { gte: thirtyDaysAgo }, totalPrice: { not: null } },
        _sum: { totalPrice: true },
      }),
    ]);

    const alerts: Alert[] = [];

    // Pending orders older than 2h
    if (pendingOrders.length > 0) {
      const plural = pendingOrders.length > 1;
      alerts.push({
        id: 'pending-over-2h',
        type: 'urgent',
        message: `${pendingOrders.length} commande${plural ? 's' : ''} attend${plural ? 'ent' : ''} ta confirmation depuis plus de 2h`,
        action: 'Voir les commandes',
        actionRoute: '/dashboard',
      });
    }

    // Today below 70% of daily average
    const avgDailyOrders = last30Count / 30;
    if (avgDailyOrders > 0 && todayOrders.length < avgDailyOrders * 0.7) {
      alerts.push({
        id: 'below-daily-average',
        type: 'info',
        message: `Tes commandes aujourd'hui (${todayOrders.length}) sont en dessous de ta moyenne journalière (${Math.round(avgDailyOrders)})`,
      });
    }

    // Today revenue above daily average
    const avgDailyRevenue = (last30RevenueAgg._sum.totalPrice ?? 0) / 30;
    const todayRevenue = todayOrders.reduce((s, o) => s + (o.totalPrice ?? 0), 0);
    if (avgDailyRevenue > 0 && todayRevenue > avgDailyRevenue) {
      alerts.push({
        id: 'above-daily-revenue',
        type: 'success',
        message: `Belle journée ! Ton CA d'aujourd'hui (${Math.round(todayRevenue)} DH) dépasse ta moyenne journalière (${Math.round(avgDailyRevenue)} DH)`,
      });
    }

    // Top client inactive for 7+ days
    if (topClientGroup.length > 0) {
      const topClient = topClientGroup[0];
      const lastOrder = await prisma.order.findFirst({
        where: { businessId, customerPhone: topClient.customerPhone },
        orderBy: { createdAt: 'desc' },
      });
      if (lastOrder && lastOrder.createdAt < sevenDaysAgo) {
        alerts.push({
          id: 'top-client-inactive',
          type: 'info',
          message: `${topClient.customerName} n'a pas commandé depuis 7 jours`,
          action: 'Envoyer un message',
        });
      }
    }

    // Cancellation rate > 20% this week
    if (weekOrders.length > 0) {
      const cancelledCount = weekOrders.filter(o => o.status === 'CANCELLED').length;
      const cancelRate = Math.round((cancelledCount / weekOrders.length) * 100);
      if (cancelRate > 20) {
        alerts.push({
          id: 'high-cancellation-rate',
          type: 'warning',
          message: `Ton taux d'annulation est élevé cette semaine (${cancelRate}%)`,
        });
      }
    }

    res.json(alerts);
  } catch (err) {
    console.error('[agent/alerts] error:', err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// GET /api/agent/advice
router.get('/advice', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const context = await buildContext(businessId);

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 150,
      system: `Tu es un conseiller business expert en e-commerce marocain et boutiques Instagram. Tu donnes UN seul conseil court et actionnable basé sur les vraies données de la boutique. Maximum 2 phrases. Conseil pratique et spécifique, pas générique.

IMPORTANT: Réponds en texte brut uniquement. Pas de markdown, pas d'astérisques, pas de hashtags, pas d'emojis, pas de titres. Juste du texte naturel comme si tu parlais à voix haute.`,
      messages: [
        {
          role: 'user',
          content: `Données boutique: ${JSON.stringify(context)}\nGénère UN conseil business personnalisé pour aujourd'hui.`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Non-text response');
    res.json({ advice: content.text });
  } catch (err) {
    console.error('[agent/advice] error:', err);
    res.status(500).json({ error: 'Impossible de générer le conseil du jour.' });
  }
});

// GET /api/agent/daily-summary
router.get('/daily-summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const context = await buildContext(businessId);

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 250,
      system: `Tu es un assistant business qui fait un résumé quotidien naturel et encourageant en français pour un propriétaire de boutique marocaine. Maximum 3-4 phrases, ton chaleureux et direct.

IMPORTANT: Réponds en texte brut uniquement. Pas de markdown, pas d'astérisques, pas de hashtags, pas d'emojis, pas de titres. Juste du texte naturel comme si tu parlais à voix haute.`,
      messages: [
        {
          role: 'user',
          content: `Voici les données de ma boutique aujourd'hui: ${JSON.stringify({ businessName: context.businessName, today: context.today, thisMonth: context.thisMonth })}. Génère un résumé du jour naturel et motivant.`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Non-text response');
    res.json({ summary: content.text, data: { today: context.today, thisMonth: context.thisMonth } });
  } catch (err) {
    console.error('[agent/daily-summary] error:', err);
    res.status(500).json({ error: 'Impossible de générer le résumé du jour.' });
  }
});

// GET /api/agent/tts-languages — temporary debug: list CAMB.AI voices (no auth required)
router.get('/tts-languages', async (_req, res) => {
  try {
    const CAMB_API_KEY = process.env.CAMB_API_KEY;
    if (!CAMB_API_KEY) { res.status(500).json({ error: 'CAMB_API_KEY not configured' }); return; }

    const response = await fetch('https://client.camb.ai/apis/list-voices', {
      headers: { 'x-api-key': CAMB_API_KEY },
    });

    const data = await response.json();
    console.log('[TTS] CAMB.AI voices:', JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error('[TTS] voices error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// GET /api/agent/audio/:runId — public, sends full CAMB.AI audio buffer
router.get('/audio/:runId', async (req, res) => {
  try {
    const CAMB_API_KEY = process.env.CAMB_API_KEY;
    if (!CAMB_API_KEY) { res.status(500).end(); return; }

    const audioRes = await fetch(
      `https://client.camb.ai/apis/tts-result/${req.params.runId}`,
      { headers: { 'x-api-key': CAMB_API_KEY, 'Content-Type': 'application/json' } },
    );

    const buffer = Buffer.from(await audioRes.arrayBuffer());
    const contentType = audioRes.headers.get('content-type') || 'audio/flac';
    console.log('[TTS] Serving audio, content-type:', contentType, 'size:', buffer.length);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length); // use actual buffer size, not upstream header
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.end(buffer);
  } catch (error) {
    console.error('[TTS] audio serve error:', error);
    res.status(500).end();
  }
});

// POST /api/agent/speak
router.post('/speak', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { text } = req.body as { text: string };

    const cleanText = (text ?? '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/[*_`#]/g, '')
      .substring(0, 200)
      .trim();

    if (!cleanText) {
      res.status(400).json({ error: 'Text requis' });
      return;
    }

    const CAMB_API_KEY = process.env.CAMB_API_KEY;
    if (!CAMB_API_KEY) throw new Error('CAMB_API_KEY not configured');

    const cambHeaders = {
      'x-api-key': CAMB_API_KEY,
      'Content-Type': 'application/json',
    };

    // Step 1: create TTS task (Melanie Deschamps, French)
    const ttsRes = await fetch('https://client.camb.ai/apis/tts', {
      method: 'POST',
      headers: cambHeaders,
      body: JSON.stringify({ text: cleanText, voice_id: 170895, language: 76, output_format: 'mp3' }),
    });

    console.log('[TTS] TTS response status:', ttsRes.status);

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('[TTS] TTS error:', err);
      throw new Error(`CAMB.AI error: ${ttsRes.status}`);
    }

    const ttsData = await ttsRes.json() as { task_id: string };
    const taskId = ttsData.task_id;
    console.log('[TTS] task_id:', taskId);

    // Step 2: poll for completion
    let runId: string | null = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const statusRes = await fetch(`https://client.camb.ai/apis/tts/${taskId}`, {
        headers: cambHeaders,
      });
      const statusData = await statusRes.json() as { status: string; run_id?: string };
      console.log('[TTS] Poll', i + 1, '- full response:', JSON.stringify(statusData));
      const st = statusData.status?.toUpperCase();
      if (st === 'SUCCESS' || st === 'COMPLETED' || st === 'DONE') { runId = statusData.run_id ?? null; break; }
      if (st === 'FAILED' || st === 'ERROR') throw new Error('TTS failed');
    }

    if (!runId) throw new Error('TTS timeout');

    // Probe the audio endpoint — if CAMB.AI redirects to a CDN (S3/GCS),
    // response.url will be the public CDN URL the browser can fetch directly.
    const probeRes = await fetch(
      `https://client.camb.ai/apis/tts-result/${runId}`,
      { headers: cambHeaders },
    );
    const audioUrl = probeRes.url !== `https://client.camb.ai/apis/tts-result/${runId}`
      ? probeRes.url                        // public CDN URL — browser fetches directly
      : `/api/agent/audio/${runId}`;        // no redirect — fall back to our proxy
    console.log('[TTS] audioUrl:', audioUrl);
    res.json({ audioUrl });
  } catch (error) {
    console.error('[TTS] Error:', error);
    res.status(500).json({ error: 'TTS failed', fallback: true });
  }
});

export default router;
