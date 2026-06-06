export interface ParsedOrder {
    isOrder: boolean;
    customerName: string | null;
    product: string | null;
    quantity: number | null;
    address: string | null;
    deliveryDate: string | null;
    totalPrice: number | null;
}
export declare function parseOrderFromMessage(messageText: string): Promise<ParsedOrder>;
export declare const parseOrderMessage: typeof parseOrderFromMessage;
//# sourceMappingURL=llmParser.d.ts.map