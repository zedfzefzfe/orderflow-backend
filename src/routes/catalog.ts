import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/catalog
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const items = await prisma.productCatalog.findMany({
      where: { businessId: req.user!.businessId },
      orderBy: { name: 'asc' },
    });
    res.json(items);
  } catch (err) {
    console.error('Catalog list error:', err);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// POST /api/catalog
router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { name, price } = req.body;
    if (!name || typeof price !== 'number' || price < 0) {
      res.status(400).json({ error: 'name (string) and price (number >= 0) are required' });
      return;
    }
    const item = await prisma.productCatalog.create({
      data: { businessId: req.user!.businessId, name: name.trim(), price },
    });
    res.status(201).json(item);
  } catch (err) {
    console.error('Catalog create error:', err);
    res.status(500).json({ error: 'Failed to create catalog item' });
  }
});

// PUT /api/catalog/:id
router.put('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { name, price } = req.body;

    const existing = await prisma.productCatalog.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Catalog item not found' });
      return;
    }

    const data: { name?: string; price?: number } = {};
    if (name !== undefined) data.name = String(name).trim();
    if (price !== undefined) data.price = Number(price);

    const updated = await prisma.productCatalog.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error('Catalog update error:', err);
    res.status(500).json({ error: 'Failed to update catalog item' });
  }
});

// DELETE /api/catalog/:id
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.productCatalog.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Catalog item not found' });
      return;
    }
    await prisma.productCatalog.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Catalog delete error:', err);
    res.status(500).json({ error: 'Failed to delete catalog item' });
  }
});

export default router;
