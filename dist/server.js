import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
const app = express();
const PORT = process.env.PORT || 3001;
// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
//# sourceMappingURL=server.js.map