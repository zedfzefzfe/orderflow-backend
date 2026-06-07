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
      'Prix livraison (DH)': o.deliveryPrice ?? '',
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

// PATCH /api/orders/:id - Update any order fields
router.patch('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { status, price, customerName, customerPhone, product, quantity, address, deliveryDate, deliveryPrice } = req.body;

    const order = await prisma.order.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    const data: Record<string, unknown> = {};

    if (status !== undefined) {
      if (!['CONFIRMED', 'DELIVERED', 'CANCELLED'].includes(status)) {
        res.status(400).json({ error: 'Invalid status' }); return;
      }
      data.status = status;
    }
    if (customerName !== undefined) data.customerName = String(customerName).trim();
    if (customerPhone !== undefined) data.customerPhone = String(customerPhone).trim();
    if (product !== undefined) data.product = String(product).trim();
    if (address !== undefined) data.address = address === '' ? null : String(address).trim();
    if (deliveryDate !== undefined) data.deliveryDate = deliveryDate === '' ? null : String(deliveryDate).trim();

    const newQty = quantity !== undefined ? parseInt(String(quantity)) : null;
    if (newQty !== null && (!isNaN(newQty) && newQty > 0)) data.quantity = newQty;

    if (price !== undefined) {
      if (price === null) {
        data.price = null;
        data.totalPrice = null;
      } else {
        const priceNum = typeof price === 'number' ? price : parseFloat(String(price));
        if (isNaN(priceNum) || priceNum < 0) {
          res.status(400).json({ error: 'Invalid price' }); return;
        }
        const effectiveQty = (data.quantity as number | undefined) ?? order.quantity;
        data.price = priceNum;
        data.totalPrice = priceNum * effectiveQty;
      }
    } else if (data.quantity !== undefined && order.price !== null) {
      // quantity changed without new price — recalculate totalPrice
      data.totalPrice = order.price * (data.quantity as number);
    }

    if (deliveryPrice !== undefined) {
      if (deliveryPrice === null) {
        data.deliveryPrice = null;
      } else {
        const dpNum = typeof deliveryPrice === 'number' ? deliveryPrice : parseFloat(String(deliveryPrice));
        if (isNaN(dpNum) || dpNum < 0) {
          res.status(400).json({ error: 'Invalid deliveryPrice' }); return;
        }
        data.deliveryPrice = dpNum;
      }
    }

    const updated = await prisma.order.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// DELETE /api/orders/:id
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    await prisma.order.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete order error:', err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

export default router;
