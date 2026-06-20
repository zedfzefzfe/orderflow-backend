import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
const router = Router();
// GET /api/stats?period=today|week|month|all
router.get('/', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const { period } = req.query;
        const now = new Date();
        let periodStart = null;
        if (period === 'today') {
            periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        }
        else if (period === 'week') {
            const d = new Date(now);
            d.setDate(d.getDate() - 6);
            d.setHours(0, 0, 0, 0);
            periodStart = d;
        }
        else if (period === 'month') {
            const d = new Date(now);
            d.setDate(d.getDate() - 29);
            d.setHours(0, 0, 0, 0);
            periodStart = d;
        }
        const baseWhere = {
            businessId,
            ...(periodStart ? { createdAt: { gte: periodStart } } : {}),
        };
        // For the "ordersThisWeek" sub-stat always show current week regardless of period
        const dayOfWeek = now.getDay();
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - diffToMonday);
        weekStart.setHours(0, 0, 0, 0);
        const [totalOrders, ordersThisWeek, pendingOrders, statusCounts, needsReviewCount] = await Promise.all([
            prisma.order.count({ where: baseWhere }),
            prisma.order.count({ where: { businessId, createdAt: { gte: weekStart } } }),
            prisma.order.count({ where: { ...baseWhere, status: 'CONFIRMED' } }),
            prisma.order.groupBy({
                by: ['status'],
                where: baseWhere,
                _count: { status: true },
            }),
            prisma.order.count({ where: { businessId, needsReview: true } }),
        ]);
        const statusBreakdown = statusCounts.reduce((acc, curr) => {
            acc[curr.status] = curr._count.status;
            return acc;
        }, {});
        res.json({ totalOrders, ordersThisWeek, pendingOrders, needsReviewCount, statusBreakdown });
    }
    catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});
// GET /api/stats/cashflow — CA encaissé vs en attente (scopé au business)
router.get('/cashflow', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const [livreesRows, retourneesCount, enAttenteRows] = await Promise.all([
            prisma.order.findMany({
                where: { businessId, status: { in: ['LIVRE', 'DELIVERED'] } },
                select: { totalPrice: true, deliveryPrice: true },
            }),
            prisma.order.count({
                where: { businessId, status: { in: ['RETOURNE', 'CANCELLED'] } },
            }),
            prisma.order.findMany({
                where: { businessId, status: { in: ['CONFIRMED', 'EN_LIVRAISON'] } },
                select: { totalPrice: true, deliveryPrice: true },
            }),
        ]);
        const sumCOD = (rows) => rows.reduce((sum, o) => sum + (o.totalPrice ?? 0) + (o.deliveryPrice ?? 0), 0);
        const caEncaisse = sumCOD(livreesRows);
        const caEnAttente = sumCOD(enAttenteRows);
        const nbLivrees = livreesRows.length;
        const nbEnAttente = enAttenteRows.length;
        const tauxLivraison = nbLivrees + retourneesCount > 0
            ? Math.round((nbLivrees / (nbLivrees + retourneesCount)) * 100)
            : 100;
        res.json({ caEncaisse, caEnAttente, nbLivrees, nbEnAttente, tauxLivraison });
    }
    catch (err) {
        console.error('Cashflow stats error:', err);
        res.status(500).json({ error: 'Failed to fetch cashflow stats' });
    }
});
export default router;
//# sourceMappingURL=stats.js.map