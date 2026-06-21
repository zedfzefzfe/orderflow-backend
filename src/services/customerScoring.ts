import { prisma } from '../lib/prisma.js';
import { normalizePhone } from '../utils/normalizePhone.js';

const CLIENT_FAULT_REASONS = new Set([
  'INJOIGNABLE',
  'REFUSE_LIVRAISON',
  'FAUSSE_COMMANDE',
  'ANNULE_AVANT_LIVRAISON',
]);

export async function recomputeCustomer(rawPhone: string, businessId: string): Promise<void> {
  const phone = normalizePhone(rawPhone);
  // Suffix match covers all formatting variants in legacy data (+212..., 06..., etc.)
  const suffix = phone.slice(-9);

  const allOrders = await prisma.order.findMany({
    where: {
      businessId,
      customerPhone: { contains: suffix },
    },
    select: {
      customerName: true,
      status: true,
      returnReason: true,
      createdAt: true,
    },
  });

  if (allOrders.length === 0) return;

  const totalOrders = allOrders.length;
  const names = [
    ...new Set(allOrders.map((o) => o.customerName?.trim()).filter(Boolean) as string[]),
  ];
  const lastOrderAt = allOrders.reduce<Date | null>(
    (max, o) => (!max || o.createdAt > max ? o.createdAt : max),
    null,
  );

  let delivered = 0;
  let clientFaultReturns = 0;
  let reporteClient = 0;
  let legitReturns = 0;

  for (const o of allOrders) {
    if (o.status === 'LIVRE' || o.status === 'DELIVERED') {
      delivered++;
      continue;
    }
    if (o.status !== 'RETOURNE' && o.status !== 'ANNULE' && o.status !== 'CANCELLED') continue;

    const reason = o.returnReason as string | null;
    if (!reason) continue;

    if (CLIENT_FAULT_REASONS.has(reason)) {
      clientFaultReturns++;
    } else if (reason === 'REPORTE_CLIENT') {
      reporteClient++;
    } else if (reason === 'MAUVAISE_ADRESSE' || reason === 'PROBLEME_PRODUIT') {
      legitReturns++;
    }
    // AUTRE → ne compte pas dans le scoring
  }

  const faultPoints = clientFaultReturns + reporteClient * 0.5;
  const scoredOrders = delivered + clientFaultReturns + reporteClient;
  const ratio = scoredOrders > 0 ? faultPoints / scoredOrders : 0;
  const riskScore = Math.round(ratio * 100);

  let riskLevel: string;
  if (scoredOrders < 2) {
    riskLevel = 'FIABLE';
  } else if (ratio >= 0.5) {
    riskLevel = 'MAUVAIS';
  } else if (ratio >= 0.2) {
    riskLevel = 'A_SURVEILLER';
  } else {
    riskLevel = 'FIABLE';
  }

  await prisma.customer.upsert({
    where: { phone_businessId: { phone, businessId } },
    create: {
      phone,
      businessId,
      names,
      totalOrders,
      delivered,
      clientFaultReturns,
      reporteClient,
      legitReturns,
      faultPoints,
      riskScore,
      riskLevel,
      lastOrderAt,
    },
    update: {
      names,
      totalOrders,
      delivered,
      clientFaultReturns,
      reporteClient,
      legitReturns,
      faultPoints,
      riskScore,
      riskLevel,
      lastOrderAt,
    },
  });
}
