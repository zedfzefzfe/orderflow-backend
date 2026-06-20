interface WeeklyStats {
    totalOrders: number;
    confirmedOrders: number;
    deliveredOrders: number;
    cancelledOrders: number;
    caReel: number;
    caEstime: number;
    confirmationRate: number;
    returnRate: number;
    topProduct: string;
    topCity: string;
}
export declare function sendWeeklyReport(merchantEmail: string, merchantName: string, stats: WeeklyStats): Promise<boolean>;
export {};
//# sourceMappingURL=emailService.d.ts.map