export interface WhatsAppProvider {
    createInstance(businessId: string): Promise<{
        qr: string | null;
    }>;
    getQRCode(businessId: string): Promise<string | null>;
    getPairingCode(businessId: string, phoneNumber: string): Promise<string>;
    getStatus(businessId: string): Promise<{
        connected: boolean;
    }>;
    sendText(businessId: string, to: string, text: string): Promise<void>;
    sendImage(businessId: string, to: string, imageUrl: string, caption?: string): Promise<void>;
    /** Register or update the Evolution webhook for an already-known instanceName. */
    setWebhook(instanceName: string, webhookUrl: string): Promise<void>;
    /** Try multiple paths to register the webhook, logging which one succeeds. */
    updateWebhook(instanceName: string, webhookUrl: string): Promise<void>;
}
export declare function instanceNameFor(businessId: string): string;
export declare const evolutionProvider: WhatsAppProvider;
//# sourceMappingURL=evolutionProvider.d.ts.map