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
export interface ClientMessageClassification {
    name: string | null;
    address: string | null;
    date: string | null;
    phone: string | null;
}
export declare function classifyClientMessage(message: string): Promise<ClientMessageClassification>;
export interface ParsedConversationOrder {
    customerName: string | null;
    phone: string | null;
    product: string | null;
    quantity: number | null;
    address: string | null;
    deliveryDate: string | null;
    price: number | null;
    confidence: number;
}
export declare function parseOrderFromConversation(formattedConversation: string, contextNote?: string): Promise<ParsedConversationOrder>;
//# sourceMappingURL=llmParser.d.ts.map