import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/orders - List orders for the user's business
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { status, search, page = '1', limit = '50' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { businessId: req.user!.businessId };

    if (status) {
      where.status = status as string;
    }

    if (search) {
      where.OR = [
        { customerName: { contains: search as string, mode: 'insensitive' } },
        { product: { contains: search as string, mode: 'insensitive' } },
        { customerPhone: { contains: search as string } },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({ orders, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('List orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// PATCH /api/orders/:id - Update order status
router.patch('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['NEW', 'CONFIRMED', 'DELIVERED', 'CANCELLED'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const order = await prisma.order.findFirst({
      where: { id, businessId: req.user!.businessId },
    });

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { status },
    });

    res.json(updated);
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
