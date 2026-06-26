import { prisma } from '../lib/prisma.js';
import { normalizePhone } from '../utils/normalizePhone.js';
function mostFrequent(items) {
    const counts = new Map();
    for (const item of items) {
        if (item != null)
            counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    if (counts.size === 0)
        return null;
    let best = null, bestCount = 0;
    for (const [val, count] of counts) {
        if (count > bestCount) {
            bestCount = count;
            best = val;
        }
    }
    return best;
}
const CLIENT_FAULT_REASONS = new Set([
    'INJOIGNABLE',
    'REFUSE_LIVRAISON',
    'FAUSSE_COMMANDE',
    'ANNULE_AVANT_LIVRAISON',
]);
export async function recomputeCustomer(rawPhone, businessId) {
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
            totalPrice: true,
            wilaya: true,
            city: true,
        },
    });
    if (allOrders.length === 0)
        return;
    const totalOrders = allOrders.length;
    const names = [
        ...new Set(allOrders.map((o) => o.customerName?.trim()).filter(Boolean)),
    ];
    const lastOrderAt = allOrders.reduce((max, o) => (!max || o.createdAt > max ? o.createdAt : max), null);
    const firstOrderAt = allOrders.reduce((min, o) => (!min || o.createdAt < min ? o.createdAt : min), null);
    const deliveredWithPrice = allOrders.filter((o) => (o.status === 'LIVRE' || o.status === 'DELIVERED') && o.totalPrice !== null);
    const avgOrderValue = deliveredWithPrice.length > 0
        ? deliveredWithPrice.reduce((sum, o) => sum + o.totalPrice, 0) / deliveredWithPrice.length
        : null;
    const wilayaMode = mostFrequent(allOrders.map((o) => o.wilaya));
    const cityMode = mostFrequent(allOrders.map((o) => o.city));
    let delivered = 0;
    let clientFaultReturns = 0;
    let reporteClient = 0;
    let legitReturns = 0;
    for (const o of allOrders) {
        if (o.status === 'LIVRE' || o.status === 'DELIVERED') {
            delivered++;
            continue;
        }
        if (o.status !== 'RETOURNE' && o.status !== 'ANNULE' && o.status !== 'CANCELLED')
            continue;
        const reason = o.returnReason;
        if (!reason)
            continue;
        if (CLIENT_FAULT_REASONS.has(reason)) {
            clientFaultReturns++;
        }
        else if (reason === 'REPORTE_CLIENT') {
            reporteClient++;
        }
        else if (reason === 'MAUVAISE_ADRESSE' || reason === 'PROBLEME_PRODUIT') {
            legitReturns++;
        }
        // AUTRE → ne compte pas dans le scoring
    }
    const faultPoints = clientFaultReturns + reporteClient * 0.5;
    const scoredOrders = delivered + clientFaultReturns + reporteClient;
    const ratio = scoredOrders > 0 ? faultPoints / scoredOrders : 0;
    const riskScore = Math.round(ratio * 100);
    let riskLevel;
    if (scoredOrders < 2) {
        riskLevel = 'FIABLE';
    }
    else if (ratio >= 0.5) {
        riskLevel = 'MAUVAIS';
    }
    else if (ratio >= 0.2) {
        riskLevel = 'A_SURVEILLER';
    }
    else {
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
            firstOrderAt,
            avgOrderValue,
            wilaya: wilayaMode,
            city: cityMode,
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
            firstOrderAt,
            avgOrderValue,
            wilaya: wilayaMode,
            city: cityMode,
        },
    });
}
// ── Agrégation cross-merchant ──────────────────────────────────────────────────
function aggregateGlobalRisk(rows) {
    let globalDelivered = 0;
    let globalClientFaultReturns = 0;
    let globalReporteClient = 0;
    let globalFaultPoints = 0;
    let distinctMerchantsWithFault = 0;
    for (const r of rows) {
        globalDelivered += r.delivered;
        globalClientFaultReturns += r.clientFaultReturns;
        globalReporteClient += r.reporteClient;
        globalFaultPoints += r.faultPoints;
        if (r.clientFaultReturns > 0)
            distinctMerchantsWithFault++;
    }
    const globalScoredOrders = globalDelivered + globalClientFaultReturns + globalReporteClient;
    const globalRatio = globalScoredOrders > 0 ? globalFaultPoints / globalScoredOrders : 0;
    // Minimum 2 marchands distincts avec refus — évite la blacklist injuste
    const warn = distinctMerchantsWithFault >= 2 && globalRatio >= 0.4;
    const message = warn
        ? `🔴 Ce client a un historique de refus chez plusieurs marchands OrderFlow (${globalClientFaultReturns} refus sur ${globalScoredOrders} commandes).`
        : null;
    return {
        warn,
        globalClientFaultReturns,
        globalScoredOrders,
        distinctMerchantsWithFault,
        globalRatio: Math.round(globalRatio * 1000) / 1000,
        message,
    };
}
/** Vérifie le risque cross-merchant pour UN seul numéro (utilisé par l'endpoint dédié). */
export async function getGlobalClientRisk(rawPhone) {
    const phone = normalizePhone(rawPhone);
    const rows = await prisma.customer.findMany({
        where: { phone },
        select: {
            businessId: true,
            clientFaultReturns: true,
            reporteClient: true,
            delivered: true,
            faultPoints: true,
        },
    });
    return aggregateGlobalRisk(rows);
}
/**
 * Batch : vérifie le risque cross-merchant pour une liste de numéros bruts.
 * UNE seule requête DB — pas de N+1.
 * Retourne Map<normalizedPhone, warningMessage>.
 */
export async function batchGetGlobalWarnings(rawPhones) {
    if (rawPhones.length === 0)
        return new Map();
    const phoneMap = new Map(); // raw → normalized
    for (const raw of rawPhones) {
        phoneMap.set(raw, normalizePhone(raw));
    }
    const normalizedList = [...new Set(phoneMap.values())];
    const allRows = await prisma.customer.findMany({
        where: { phone: { in: normalizedList } },
        select: {
            phone: true,
            businessId: true,
            clientFaultReturns: true,
            reporteClient: true,
            delivered: true,
            faultPoints: true,
        },
    });
    // Group rows by normalized phone
    const grouped = new Map();
    for (const row of allRows) {
        if (!grouped.has(row.phone))
            grouped.set(row.phone, []);
        grouped.get(row.phone).push(row);
    }
    const result = new Map();
    for (const [phone, rows] of grouped) {
        const { warn, message } = aggregateGlobalRisk(rows);
        if (warn && message)
            result.set(phone, message);
    }
    return result; // keyed by normalized phone
}
/**
 * Vérifie le risque LOCAL (dans la boutique du marchand) pour un seul numéro.
 * Retourne null si le client est FIABLE ou inconnu.
 */
export async function getLocalClientWarning(rawPhone, businessId) {
    const phone = normalizePhone(rawPhone);
    const c = await prisma.customer.findUnique({
        where: { phone_businessId: { phone, businessId } },
        select: { riskLevel: true, clientFaultReturns: true, reporteClient: true, delivered: true },
    });
    if (!c || (c.riskLevel !== 'MAUVAIS' && c.riskLevel !== 'A_SURVEILLER'))
        return null;
    const scoredOrders = c.delivered + c.clientFaultReturns + c.reporteClient;
    return {
        clientFaultReturns: c.clientFaultReturns,
        scoredOrders,
        message: `⚠️ Ce client a déjà eu des refus dans ta boutique (${c.clientFaultReturns} refus sur ${scoredOrders} commandes).`,
    };
}
/**
 * Batch : vérifie le risque LOCAL pour une liste de numéros bruts, pour un seul businessId.
 * UNE seule requête DB — pas de N+1.
 * Retourne Map<normalizedPhone, warningMessage>.
 */
export async function batchGetLocalWarnings(rawPhones, businessId) {
    if (rawPhones.length === 0)
        return new Map();
    const phoneMap = new Map();
    for (const raw of rawPhones)
        phoneMap.set(raw, normalizePhone(raw));
    const normalizedList = [...new Set(phoneMap.values())];
    const customers = await prisma.customer.findMany({
        where: {
            phone: { in: normalizedList },
            businessId,
            riskLevel: { in: ['MAUVAIS', 'A_SURVEILLER'] },
        },
        select: { phone: true, clientFaultReturns: true, reporteClient: true, delivered: true },
    });
    const result = new Map();
    for (const c of customers) {
        const scoredOrders = c.delivered + c.clientFaultReturns + c.reporteClient;
        result.set(c.phone, `⚠️ Ce client a déjà eu des refus dans ta boutique (${c.clientFaultReturns} refus sur ${scoredOrders} commandes).`);
    }
    return result;
}
//# sourceMappingURL=customerScoring.js.map