import { Order, Business } from '@prisma/client';
export declare function notifyOwner(business: Business, order: Order): Promise<void>;
export declare function sendTextToOwner(business: Business, text: string): Promise<void>;
//# sourceMappingURL=whatsapp.d.ts.map