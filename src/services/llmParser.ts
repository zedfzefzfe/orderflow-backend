import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedOrder {
  isOrder: boolean;
  customerName: string | null;
  product: string | null;
  quantity: number | null;
  address: string | null;
  deliveryDate: string | null;
  totalPrice: number | null;
}

const SYSTEM_PROMPT = `Tu es un assistant de parsing de commandes pour une boutique e-commerce marocaine (bougies, parfums, cadeaux).
Analyse le message client et extrais les informations de commande.

Les messages peuvent être en français, arabe ou darija (dialecte arabe marocain).

Exemples de commandes (isOrder=true):
- "salam bghit 2 bougies vanille livraison Rabat nhar lkhmis" → qty=2, product="bougies vanille", address="Rabat", deliveryDate="lkhmis (jeudi)"
- "Bonjour je voudrais 1 bouquet roses éternelles, adresse Casa Maarif, livraison demain" → qty=1, product="bouquet roses éternelles", address="Casa Maarif", deliveryDate="demain"
- "3andi tlb: juj bougies oud w wahd parfum rose, livraison Marrakech" → qty=3 total, product="bougies oud et parfum rose", address="Marrakech"

Exemples de NON-commandes (isOrder=false):
- "chhal taman dyal bougie lavande?" → question prix, isOrder=false
- "salam" → salutation, isOrder=false
- "fin kayn livreur dyalkom?" → question logistique, isOrder=false
- "merci" → remerciement, isOrder=false

Retourne UNIQUEMENT un JSON valide sans markdown ni explication:
{"isOrder":boolean,"customerName":string|null,"product":string|null,"quantity":number|null,"address":string|null,"deliveryDate":string|null,"totalPrice":number|null}

Règles strictes:
- isOrder: true uniquement si le message est une demande d'achat/commande claire
- customerName: prénom ou nom mentionné, null sinon
- product: description du produit commandé, null si unclear
- quantity: nombre entier, null si unclear (ne pas supposer 1 par défaut)
- address: ville ou adresse de livraison, null si non fournie
- deliveryDate: date/jour de livraison en texte original, null si non fournie
- totalPrice: prix total si mentionné par le client, null sinon`;

async function callClaude(messageText: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: messageText }],
  });
  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Non-text response');
  return content.text.replace(/```(?:json)?\n?|\n?```/g, '').trim();
}

function parseJsonSafe(text: string): ParsedOrder | null {
  try {
    const parsed = JSON.parse(text);
    return {
      isOrder: !!parsed.isOrder,
      customerName: parsed.customerName || null,
      product: parsed.product || null,
      quantity: typeof parsed.quantity === 'number' && parsed.quantity > 0 ? parsed.quantity : null,
      address: parsed.address || null,
      deliveryDate: parsed.deliveryDate || null,
      totalPrice: typeof parsed.totalPrice === 'number' && parsed.totalPrice > 0 ? parsed.totalPrice : null,
    };
  } catch {
    return null;
  }
}

export async function parseOrderFromMessage(messageText: string): Promise<ParsedOrder> {
  try {
    const firstAttempt = parseJsonSafe(await callClaude(messageText));
    if (firstAttempt) return firstAttempt;

    console.warn('[llmParser] Invalid JSON on first attempt, retrying...');
    const secondAttempt = parseJsonSafe(await callClaude(messageText));
    if (secondAttempt) return secondAttempt;
  } catch (err) {
    console.error('[llmParser] Claude API error:', err);
  }

  // Fallback: preserve the message as a NEW order so nothing is lost
  console.warn('[llmParser] Parse failed after retry — creating fallback order');
  return {
    isOrder: true,
    customerName: null,
    product: null,
    quantity: null,
    address: null,
    deliveryDate: null,
    totalPrice: null,
  };
}

// Legacy alias for webhook compatibility
export const parseOrderMessage = parseOrderFromMessage;
