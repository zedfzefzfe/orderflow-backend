import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
const router = Router();
function getPeriodRange(days) {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);
    const prevEnd = new Date(start.getTime() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevEnd.getDate() - days + 1);
    prevStart.setHours(0, 0, 0, 0);
    return { start, prevStart, prevEnd };
}
// GET /api/analytics/summary?period=1|7|30|90
router.get('/summary', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const days = parseInt(req.query.period) || 30;
        const { start, prevStart, prevEnd } = getPeriodRange(days);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const [totalCount, confirmedCount, cancelledCount, realRevenueAgg, estimatedRevenueAgg, prevRealRevenueAgg, prevConfirmedCount, atRiskCount,] = await Promise.all([
            prisma.order.count({ where: { businessId, createdAt: { gte: start } } }),
            prisma.order.count({ where: { businessId, createdAt: { gte: start }, status: { in: ['CONFIRMED', 'DELIVERED'] } } }),
            prisma.order.count({ where: { businessId, createdAt: { gte: start }, status: 'CANCELLED' } }),
            prisma.order.aggregate({
                where: { businessId, createdAt: { gte: start }, status: { in: ['CONFIRMED', 'DELIVERED'] }, totalPrice: { not: null } },
                _sum: { totalPrice: true },
            }),
            prisma.order.aggregate({
                where: { businessId, createdAt: { gte: start }, totalPrice: { not: null } },
                _sum: { totalPrice: true },
            }),
            prisma.order.aggregate({
                where: { businessId, createdAt: { gte: prevStart, lte: prevEnd }, status: { in: ['CONFIRMED', 'DELIVERED'] }, totalPrice: { not: null } },
                _sum: { totalPrice: true },
            }),
            prisma.order.count({ where: { businessId, createdAt: { gte: prevStart, lte: prevEnd }, status: { in: ['CONFIRMED', 'DELIVERED'] } } }),
            prisma.order.count({ where: { businessId, status: 'NEW', createdAt: { lt: twoHoursAgo } } }),
        ]);
        const realRevenue = realRevenueAgg._sum.totalPrice ?? 0;
        const estimatedRevenue = estimatedRevenueAgg._sum.totalPrice ?? 0;
        const prevRealRevenue = prevRealRevenueAgg._sum.totalPrice ?? 0;
        const avgOrderValue = confirmedCount > 0 ? Math.round(realRevenue / confirmedCount) : 0;
        const prevAvgOrderValue = prevConfirmedCount > 0 ? Math.round(prevRealRevenue / prevConfirmedCount) : 0;
        const revenueEvolution = prevRealRevenue > 0
            ? Math.round(((realRevenue - prevRealRevenue) / prevRealRevenue) * 100)
            : null;
        const avgEvolution = prevAvgOrderValue > 0
            ? Math.round(((avgOrderValue - prevAvgOrderValue) / prevAvgOrderValue) * 100)
            : null;
        res.json({
            totalCount,
            confirmedCount,
            cancelledCount,
            realRevenue,
            estimatedRevenue,
            avgOrderValue,
            confirmationRate: totalCount > 0 ? Math.round((confirmedCount / totalCount) * 100) : 0,
            cancellationRate: totalCount > 0 ? Math.round((cancelledCount / totalCount) * 100) : 0,
            atRiskCount,
            revenueEvolution,
            avgEvolution,
        });
    }
    catch (err) {
        console.error('Analytics summary error:', err);
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
});
// GET /api/analytics/status-breakdown?period=
router.get('/status-breakdown', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const days = parseInt(req.query.period) || 30;
        const { start } = getPeriodRange(days);
        const rows = await prisma.order.groupBy({
            by: ['status'],
            where: { businessId, createdAt: { gte: start } },
            _count: { id: true },
        });
        const total = rows.reduce((s, r) => s + r._count.id, 0);
        res.json(rows.map((r) => ({
            status: r.status,
            count: r._count.id,
            percent: total > 0 ? Math.round((r._count.id / total) * 100) : 0,
        })));
    }
    catch (err) {
        console.error('Analytics status-breakdown error:', err);
        res.status(500).json({ error: 'Failed to fetch status breakdown' });
    }
});
// GET /api/analytics/revenue-by-day?period=
router.get('/revenue-by-day', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const days = parseInt(req.query.period) || 30;
        const { start } = getPeriodRange(days);
        const orders = await prisma.order.findMany({
            where: { businessId, createdAt: { gte: start }, status: { in: ['CONFIRMED', 'DELIVERED'] }, totalPrice: { not: null } },
            select: { createdAt: true, totalPrice: true },
        });
        const byDay = {};
        for (const o of orders) {
            const key = o.createdAt.toISOString().slice(0, 10);
            byDay[key] = (byDay[key] || 0) + (o.totalPrice ?? 0);
        }
        const result = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            result.push({ date: key, revenue: Math.round(byDay[key] || 0) });
        }
        res.json(result);
    }
    catch (err) {
        console.error('Analytics revenue-by-day error:', err);
        res.status(500).json({ error: 'Failed to fetch revenue by day' });
    }
});
// GET /api/analytics/orders-by-day?period= (kept for backward compat)
router.get('/orders-by-day', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const days = parseInt(req.query.period) || 30;
        const { start } = getPeriodRange(days);
        const orders = await prisma.order.findMany({
            where: { businessId, createdAt: { gte: start } },
            select: { createdAt: true },
        });
        const countByDay = {};
        for (const o of orders) {
            const key = o.createdAt.toISOString().slice(0, 10);
            countByDay[key] = (countByDay[key] || 0) + 1;
        }
        const result = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            result.push({ date: key, count: countByDay[key] || 0 });
        }
        res.json(result);
    }
    catch (err) {
        console.error('Analytics orders-by-day error:', err);
        res.status(500).json({ error: 'Failed to fetch orders by day' });
    }
});
// GET /api/analytics/orders-comparison — current month vs previous month by day
router.get('/orders-comparison', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const now = new Date();
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        const [thisMonthOrders, lastMonthOrders] = await Promise.all([
            prisma.order.findMany({
                where: { businessId, createdAt: { gte: thisMonthStart } },
                select: { createdAt: true },
            }),
            prisma.order.findMany({
                where: { businessId, createdAt: { gte: lastMonthStart, lte: lastMonthEnd } },
                select: { createdAt: true },
            }),
        ]);
        const thisMonthByDay = {};
        for (const o of thisMonthOrders)
            thisMonthByDay[o.createdAt.getDate()] = (thisMonthByDay[o.createdAt.getDate()] || 0) + 1;
        const lastMonthByDay = {};
        for (const o of lastMonthOrders)
            lastMonthByDay[o.createdAt.getDate()] = (lastMonthByDay[o.createdAt.getDate()] || 0) + 1;
        const result = [];
        for (let day = 1; day <= now.getDate(); day++) {
            result.push({ day, thisMonth: thisMonthByDay[day] || 0, lastMonth: lastMonthByDay[day] || 0 });
        }
        res.json(result);
    }
    catch (err) {
        console.error('Analytics orders-comparison error:', err);
        res.status(500).json({ error: 'Failed to fetch comparison' });
    }
});
// GET /api/analytics/weekly-rates — confirmation rate per week, last 8 weeks
router.get('/weekly-rates', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const now = new Date();
        const eightWeeksAgo = new Date(now.getTime() - 8 * 7 * 24 * 60 * 60 * 1000);
        eightWeeksAgo.setHours(0, 0, 0, 0);
        const orders = await prisma.order.findMany({
            where: { businessId, createdAt: { gte: eightWeeksAgo } },
            select: { createdAt: true, status: true },
        });
        const buckets = Array.from({ length: 8 }, () => ({ total: 0, confirmed: 0 }));
        for (const o of orders) {
            const msFromNow = now.getTime() - o.createdAt.getTime();
            const weekIdx = Math.floor(msFromNow / (7 * 24 * 60 * 60 * 1000));
            const bucket = 7 - weekIdx;
            if (bucket < 0 || bucket > 7)
                continue;
            buckets[bucket].total++;
            if (o.status === 'CONFIRMED' || o.status === 'DELIVERED')
                buckets[bucket].confirmed++;
        }
        res.json(buckets.map((b, i) => ({
            week: i === 7 ? 'Cette sem.' : `S-${7 - i}`,
            rate: b.total > 0 ? Math.round((b.confirmed / b.total) * 100) : 0,
            total: b.total,
        })));
    }
    catch (err) {
        console.error('Analytics weekly-rates error:', err);
        res.status(500).json({ error: 'Failed to fetch weekly rates' });
    }
});
// GET /api/analytics/top-products?period=&limit=
router.get('/top-products', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const days = parseInt(req.query.period) || 30;
        const limit = parseInt(req.query.limit) || 10;
        const { start } = getPeriodRange(days);
        const rows = await prisma.order.groupBy({
            by: ['product'],
            where: { businessId, createdAt: { gte: start }, NOT: [{ product: '' }, { product: 'Unspecified' }] },
            _count: { product: true },
            _sum: { totalPrice: true },
            orderBy: { _sum: { totalPrice: 'desc' } },
            take: limit,
        });
        const totalRevenue = rows.reduce((s, r) => s + (r._sum.totalPrice ?? 0), 0);
        res.json(rows.map((r) => ({
            product: r.product,
            count: r._count.product,
            revenue: Math.round(r._sum.totalPrice ?? 0),
            revenuePercent: totalRevenue > 0 ? Math.round(((r._sum.totalPrice ?? 0) / totalRevenue) * 100) : 0,
        })));
    }
    catch (err) {
        console.error('Analytics top-products error:', err);
        res.status(500).json({ error: 'Failed to fetch top products' });
    }
});
// GET /api/analytics/top-clients?period=&limit=
router.get('/top-clients', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const days = parseInt(req.query.period) || 30;
        const limit = parseInt(req.query.limit) || 10;
        const { start } = getPeriodRange(days);
        const rows = await prisma.order.groupBy({
            by: ['customerPhone', 'customerName'],
            where: { businessId, createdAt: { gte: start } },
            _count: { id: true },
            _sum: { totalPrice: true },
            _max: { createdAt: true, address: true },
            orderBy: { _sum: { totalPrice: 'desc' } },
            take: limit,
        });
        res.json(rows.map((r) => ({
            name: r.customerName,
            phone: r.customerPhone,
            count: r._count.id,
            revenue: Math.round(r._sum.totalPrice ?? 0),
            lastOrder: r._max.createdAt,
            city: r._max.address ?? '—',
        })));
    }
    catch (err) {
        console.error('Analytics top-clients error:', err);
        res.status(500).json({ error: 'Failed to fetch top clients' });
    }
});
// GET /api/analytics/top-cities (kept for backward compat)
router.get('/top-cities', requireAuth, async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const rows = await prisma.order.groupBy({
            by: ['address'],
            where: { businessId, NOT: { address: null }, address: { not: '' } },
            _count: { address: true },
            orderBy: { _count: { address: 'desc' } },
            take: 5,
        });
        res.json(rows.filter((r) => r.address).map((r) => ({ city: r.address, count: r._count.address })));
    }
    catch (err) {
        console.error('Analytics top-cities error:', err);
        res.status(500).json({ error: 'Failed to fetch top cities' });
    }
});
export default router;
//# sourceMappingURL=analytics.js.map