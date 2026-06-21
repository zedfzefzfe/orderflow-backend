import { Router } from 'express';
import * as XLSX from 'xlsx';
import Groq, { toFile } from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { estimateDeliveryAt } from '../utils/estimateDelivery.js';
import { ReturnReason } from '@prisma/client';
import { recomputeCustomer } from '../services/customerScoring.js';

let _groq: Groq | null = null;
function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

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

// GET /api/orders/client/:phone — order history for a specific client
router.get('/client/:phone', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const rawPhone = req.params.phone.replace(/\s/g, '');
    const suffix = rawPhone.slice(-9);

    const orders = await prisma.order.findMany({
      where: {
        businessId,
        customerPhone: { contains: suffix },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalCA = orders.reduce(
      (sum, o) => sum + (o.price ?? 0) * (o.quantity ?? 1) + (o.deliveryPrice ?? 0),
      0,
    );

    res.json({ orders, totalCA, totalOrders: orders.length });
  } catch (err) {
    console.error('Client history error:', err);
    res.status(500).json({ error: 'Failed to fetch client history' });
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

    const VALID_STATUSES = ['CONFIRMED', 'EN_LIVRAISON', 'LIVRE', 'RETOURNE', 'ANNULE', 'DELIVERED', 'CANCELLED'];
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        res.status(400).json({ error: 'Invalid status' }); return;
      }
      data.status = status;
      if (status === 'LIVRE') data.deliveredAt = new Date();
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

// POST /api/orders — create order manually (used by voice + manual form)
router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { customerName, customerPhone, product, quantity, price, deliveryPrice, address, deliveryDate } = req.body;

    if (!customerName || !product) {
      res.status(400).json({ error: 'customerName and product are required' }); return;
    }

    const priceNum = price != null ? parseFloat(String(price)) : null;
    const deliveryNum = deliveryPrice != null ? parseFloat(String(deliveryPrice)) : 0;
    const qty = parseInt(String(quantity ?? 1)) || 1;
    const totalPrice = priceNum != null ? priceNum * qty : null;

    const order = await prisma.order.create({
      data: {
        businessId,
        customerName,
        customerPhone: customerPhone || '',
        product,
        quantity: qty,
        price: priceNum,
        totalPrice,
        deliveryPrice: isNaN(deliveryNum) ? 0 : deliveryNum,
        address: address || null,
        deliveryDate: deliveryDate || null,
        status: 'CONFIRMED',
        needsReview: false,
        rawMessage: '',
        source: 'manual',
      },
    });

    res.json(order);
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// POST /api/orders/batch-status — bulk status update (e.g. "Clôturer la journée")
router.post('/batch-status', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { updates } = req.body as { updates: { orderId: string; status: string }[] };

    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: 'updates array required' }); return;
    }

    const VALID = ['CONFIRMED', 'EN_LIVRAISON', 'LIVRE', 'RETOURNE', 'ANNULE', 'DELIVERED', 'CANCELLED'];
    const now = new Date();

    const results = await Promise.all(
      updates
        .filter(({ status }) => VALID.includes(status))
        .map(({ orderId, status }) => {
          const data: Record<string, unknown> = { status };
          if (status === 'LIVRE') data.deliveredAt = now;
          return prisma.order.updateMany({ where: { id: orderId, businessId }, data });
        }),
    );

    const updated = results.reduce((sum, r) => sum + r.count, 0);
    res.json({ updated });
  } catch (err) {
    console.error('Batch status error:', err);
    res.status(500).json({ error: 'Failed to update orders' });
  }
});

// POST /api/orders/voice — transcribe audio + extract order fields
router.post('/voice', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { audio, mimeType = 'audio/webm' } = req.body;
    if (!audio) { res.status(400).json({ error: 'audio field required' }); return; }

    const audioBuffer = Buffer.from(audio, 'base64');
    const ext = mimeType.includes('webm') ? 'webm'
      : mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'mp4'
      : mimeType.includes('wav') ? 'wav' : 'webm';

    const audioFile = await toFile(audioBuffer, `voice.${ext}`, { type: mimeType });

    console.log('[VOICE] Transcribing audio, size:', audioBuffer.length);

    const transcription = await getGroq().audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      prompt: 'Commande e-commerce Maroc: nom client, produit, prix dirhams, adresse livraison, date livraison',
      response_format: 'text',
    });

    const text = (typeof transcription === 'string'
      ? transcription
      : (transcription as unknown as { text: string }).text ?? ''
    ).trim();

    console.log('[VOICE] Transcription:', text);

    const aiResponse = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extrait les informations de commande depuis cette transcription vocale.

Transcription: "${text}"

Réponds UNIQUEMENT en JSON:
{"customerName":"nom ou null","phone":"téléphone ou null","product":"produit ou null","quantity":1,"price":nombre ou null,"deliveryPrice":nombre ou null,"address":"adresse ou null","deliveryDate":"date ou null"}

IMPORTANT: JSON only, no markdown.`,
      }],
    });

    const rawText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : '{}';
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[^]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    console.log('[VOICE] Parsed fields:', parsed);

    res.json({ ...parsed, transcription: text });
  } catch (err) {
    console.error('[VOICE] Error:', err);
    res.status(500).json({ error: 'Voice processing failed' });
  }
});

const STATUSES_REQUIRING_REASON: string[] = ['RETOURNE', 'ANNULE'];
const VALID_RETURN_REASONS = Object.values(ReturnReason);

// PATCH /api/orders/:id/status — marchand status lifecycle
router.patch('/:id/status', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { status, returnReason } = req.body;

    const order = await prisma.order.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    // Autoriser RETOURNE/ANNULE même si déjà résolu (correction d'erreur marchand)
    if (order.confirmationResolved && !STATUSES_REQUIRING_REASON.includes(status)) {
      res.status(409).json({ error: 'Cette commande est déjà résolue' }); return;
    }

    const VALID_STATUSES = ['CONFIRMED', 'EN_LIVRAISON', 'LIVRE', 'RETOURNE', 'ANNULE'];
    if (!status || !VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: 'Statut invalide' }); return;
    }

    if (STATUSES_REQUIRING_REASON.includes(status)) {
      if (!returnReason || !VALID_RETURN_REASONS.includes(returnReason)) {
        res.status(400).json({
          error: 'returnReason est obligatoire pour ce statut',
          validValues: VALID_RETURN_REASONS,
        });
        return;
      }
    }

    const now = new Date();
    const data: Record<string, unknown> = { status };

    if (status === 'EN_LIVRAISON') {
      data.deliveryAttemptedAt = now;
      data.estimatedDeliveryAt = estimateDeliveryAt(order);
    }

    if (status === 'LIVRE') {
      data.confirmationResolved = true;
      data.confirmationSource = 'marchand';
      data.confirmationResolvedAt = now;
      data.deliveredAt = now;
    }

    if (STATUSES_REQUIRING_REASON.includes(status)) {
      data.returnReason = returnReason as ReturnReason;
      data.confirmationResolved = true;
      data.confirmationSource = 'marchand';
      data.confirmationResolvedAt = now;
    }

    const updated = await prisma.order.update({ where: { id }, data });
    res.json(updated);

    // Recompute customer score after terminal status change (fire-and-forget)
    const TERMINAL = ['LIVRE', 'RETOURNE', 'ANNULE'];
    if (TERMINAL.includes(status)) {
      recomputeCustomer(order.customerPhone, order.businessId).catch((err) =>
        console.error('[scoring] recompute failed:', err),
      );
    }
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

export default router;
