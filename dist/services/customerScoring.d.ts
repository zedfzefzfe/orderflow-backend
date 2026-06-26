export interface GlobalRiskResult {
    warn: boolean;
    globalClientFaultReturns: number;
    globalScoredOrders: number;
    distinctMerchantsWithFault: number;
    globalRatio: number;
    message: string | null;
}
export declare function recomputeCustomer(rawPhone: string, businessId: string): Promise<void>;
/** Vérifie le risque cross-merchant pour UN seul numéro (utilisé par l'endpoint dédié). */
export declare function getGlobalClientRisk(rawPhone: string): Promise<GlobalRiskResult>;
/**
 * Batch : vérifie le risque cross-merchant pour une liste de numéros bruts.
 * UNE seule requête DB — pas de N+1.
 * Retourne Map<normalizedPhone, warningMessage>.
 */
export declare function batchGetGlobalWarnings(rawPhones: string[]): Promise<Map<string, string>>;
export interface LocalRiskResult {
    message: string;
    clientFaultReturns: number;
    scoredOrders: number;
}
/**
 * Vérifie le risque LOCAL (dans la boutique du marchand) pour un seul numéro.
 * Retourne null si le client est FIABLE ou inconnu.
 */
export declare function getLocalClientWarning(rawPhone: string, businessId: string): Promise<LocalRiskResult | null>;
/**
 * Batch : vérifie le risque LOCAL pour une liste de numéros bruts, pour un seul businessId.
 * UNE seule requête DB — pas de N+1.
 * Retourne Map<normalizedPhone, warningMessage>.
 */
export declare function batchGetLocalWarnings(rawPhones: string[], businessId: string): Promise<Map<string, string>>;
//# sourceMappingURL=customerScoring.d.ts.map