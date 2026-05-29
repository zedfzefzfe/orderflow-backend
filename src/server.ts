import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import webhookRoutes from './routes/webhook.js';
import orderRoutes from './routes/orders.js';
import statsRoutes from './routes/stats.js';
import simulateRoutes from './routes/simulate.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/webhook/whatsapp', webhookRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/simulate', simulateRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`OrderFlow API running on port ${PORT}`);
});
