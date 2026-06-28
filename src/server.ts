console.log('[BOOT] server.ts loaded — build version:', new Date().toISOString());

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import webpush from 'web-push';
import webhookRoutes from './routes/webhook.js';
import orderRoutes from './routes/orders.js';
import statsRoutes from './routes/stats.js';
import simulateRoutes from './routes/simulate.js';
import businessRoutes from './routes/business.js';
import onboardingRoutes from './routes/onboarding.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import catalogRoutes from './routes/catalog.js';
import agentRoutes from './routes/agent.js';
import customerRoutes from './routes/customers.js';
import whatsappRoutes from './whatsapp/routes.js';
import { sendAllWeeklyReports } from './services/weeklyReport.js';
import { prisma } from './lib/prisma.js';
import './cron/deliveryReminders.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logger — makes every inbound request visible in Railway deploy logs
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/webhook/whatsapp', webhookRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/simulate', simulateRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function configureEvolutionWebhook() {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.AUTHENTICATION_API_KEY;
  const INSTANCE = 'merchant_8ececf89-a697-47cc-b7c9-124951348c80';
  const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://orderflow-backend-production-9d9d.up.railway.app';

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return;

  const _raw = EVOLUTION_API_URL.trim();
  const evoBase = _raw.startsWith('http://') || _raw.startsWith('https://')
    ? _raw.replace(/\/$/, '')
    : `https://${_raw.replace(/\/$/, '')}`;

  console.log('[evolution] configureEvolutionWebhook base URL:', evoBase);

  try {
    const res = await fetch(`${evoBase}/webhook/set/${INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({
        webhook: {
          url: `${BACKEND_URL}/api/whatsapp/webhook/${INSTANCE}`,
          enabled: true,
          webhookByEvents: false,
          webhookBase64: false,
          events: ['MESSAGES_UPSERT'],
          retryOnError: true,
          maxRetries: 5,
          retryInterval: 30,
        },
      }),
    });
    const data = await res.json();
    console.log('[evolution] webhook retry configured:', JSON.stringify(data));
  } catch (err) {
    console.error('[evolution] failed to configure webhook retry:', err);
  }
}

app.listen(PORT, () => {
  console.log(`OrderFlow API running on port ${PORT}`);
  configureEvolutionWebhook();
});

// Every Monday at 8:00 AM Morocco time
cron.schedule('0 7 * * 1', async () => {
  console.log('[CRON] Running weekly reports...');
  await sendAllWeeklyReports();
}, { timezone: 'Africa/Casablanca' });

// Every day at 20:00 Morocco time — delivery confirmation reminder
cron.schedule('0 20 * * *', async () => {
  console.log('[CRON] Running daily delivery reminder...');
  try {
    const businesses = await prisma.business.findMany({
      where: { pushSubscription: { not: null } },
    });

    for (const business of businesses) {
      const pendingOrders = await prisma.order.findMany({
        where: { businessId: business.id, status: { in: ['CONFIRMED', 'EN_LIVRAISON'] as any[] } },
        select: { totalPrice: true, deliveryPrice: true },
      });
      if (pendingOrders.length === 0) continue;

      const caEnAttente = pendingOrders.reduce(
        (sum, o) => sum + (o.totalPrice ?? 0) + (o.deliveryPrice ?? 0),
        0,
      );
      const n = pendingOrders.length;

      try {
        await webpush.sendNotification(
          JSON.parse(business.pushSubscription!),
          JSON.stringify({
            title: 'OrderFlow — Rappel de soirée',
            body: `📦 Tu as ${n} livraison${n > 1 ? 's' : ''} en cours · ${caEnAttente.toLocaleString('fr-FR')} DH en attente. Confirme celles qui sont arrivées 💰`,
          }),
        );
        console.log(`[CRON] Reminder sent to business ${business.id}`);
      } catch (e) {
        console.error(`[CRON] Push failed for business ${business.id}:`, e);
      }
    }
  } catch (err) {
    console.error('[CRON] Daily reminder error:', err);
  }
}, { timezone: 'Africa/Casablanca' });

console.log('[CRON] Weekly report scheduled every Monday at 8:00 AM');
console.log('[CRON] Daily delivery reminder scheduled at 20:00 Africa/Casablanca');
