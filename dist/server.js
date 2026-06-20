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
import { sendAllWeeklyReports } from './services/weeklyReport.js';
import { prisma } from './lib/prisma.js';
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
// 404 handler
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});
// Error handler
app.use((err, _req, res, _next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});
app.listen(PORT, () => {
    console.log(`OrderFlow API running on port ${PORT}`);
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
                where: { businessId: business.id, status: { in: ['CONFIRMED', 'EN_LIVRAISON'] } },
                select: { totalPrice: true, deliveryPrice: true },
            });
            if (pendingOrders.length === 0)
                continue;
            const caEnAttente = pendingOrders.reduce((sum, o) => sum + (o.totalPrice ?? 0) + (o.deliveryPrice ?? 0), 0);
            const n = pendingOrders.length;
            try {
                await webpush.sendNotification(JSON.parse(business.pushSubscription), JSON.stringify({
                    title: 'OrderFlow — Rappel de soirée',
                    body: `📦 Tu as ${n} livraison${n > 1 ? 's' : ''} en cours · ${caEnAttente.toLocaleString('fr-FR')} DH en attente. Confirme celles qui sont arrivées 💰`,
                }));
                console.log(`[CRON] Reminder sent to business ${business.id}`);
            }
            catch (e) {
                console.error(`[CRON] Push failed for business ${business.id}:`, e);
            }
        }
    }
    catch (err) {
        console.error('[CRON] Daily reminder error:', err);
    }
}, { timezone: 'Africa/Casablanca' });
console.log('[CRON] Weekly report scheduled every Monday at 8:00 AM');
console.log('[CRON] Daily delivery reminder scheduled at 20:00 Africa/Casablanca');
//# sourceMappingURL=server.js.map