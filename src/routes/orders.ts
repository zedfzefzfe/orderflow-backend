import { Router } from 'express';
import * as XLSX from 'xlsx';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// GET /api/orders - List orders for the user's business
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { status, search, page = '1', limit = '50', dateFrom } = req.query;
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit as string) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { businessId: req.user!.businessId };

    if (status) {
      where.status = status as string;
    }

    if (dateFrom) {
      where.createdAt = { gte: new Date(dateFrom as string) };
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

// GET /api/orders/export - CSV or Excel download
router.get('/export', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { month, format = 'csv' } = req.query as { month?: string; format?: string };
    const businessId = req.user!.businessId;

    let dateFilter: { gte?: Date; lt?: Date } = {};
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [year, mon] = month.split('-').map(Number);
      dateFilter = { gte: new Date(year, mon - 1, 1), lt: new Date(year, mon, 1) };
    }

    const orders = await prisma.order.findMany({
      where: { businessId, ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}) },
      orderBy: { createdAt: 'desc' },
    });

    const rows = orders.map((o) => ({
      Date: o.createdAt.toISOString().slice(0, 10),
      Client: o.customerName,
      'Téléphone': o.customerPhone,
      Produit: o.product,
      'Quantité': o.quantity,
      Adresse: o.address || '',
      Livraison: o.deliveryDate || '',
      Statut: o.status,
      'Prix (DH)': o.totalPrice ?? '',
    }));

    const monthLabel = month
      ? new Date(month + '-01').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }).replace(' ', '_')
      : 'toutes';
    const baseFilename = `commandes_${monthLabel}`;

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Commandes');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.xlsx"`);
      res.send(buf);
    } else {
      const headers = ['Date', 'Client', 'Téléphone', 'Produit', 'Quantité', 'Adresse', 'Livraison', 'Statut', 'Prix (DH)'];
      const csvLines = [
        headers.join(','),
        ...rows.map((r) =>
          headers.map((h) => {
            const val = String((r as Record<string, unknown>)[h] ?? '');
            return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
          }).join(',')
        ),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.csv"`);
      res.send('﻿' + csvLines.join('\n'));
    }
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export orders' });
  }
});

// PATCH /api/orders/:id - Update order status and/or unit price
router.patch('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { status, price } = req.body;

    if (status === undefined && price === undefined) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    const order = await prisma.order.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    const data: Record<string, unknown> = {};

    if (status !== undefined) {
      if (!['NEW', 'CONFIRMED', 'DELIVERED', 'CANCELLED'].includes(status)) {
        res.status(400).json({ error: 'Invalid status' }); return;
      }
      data.status = status;
    }

    if (price !== undefined) {
      if (price === null) {
        data.price = null;
        data.totalPrice = null;
      } else {
        const priceNum = typeof price === 'number' ? price : parseFloat(String(price));
        if (isNaN(priceNum) || priceNum < 0) {
          res.status(400).json({ error: 'Invalid price' }); return;
        }
        data.price = priceNum;
        data.totalPrice = priceNum * order.quantity;
      }
    }

    const updated = await prisma.order.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
