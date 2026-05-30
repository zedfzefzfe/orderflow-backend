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

const SYSTEM_PROMPT = `Tu es un extracteur de données pour commandes d'une boutique marocaine (bougies, parfums, bouquets, cadeaux).

TÂCHE: Analyser le message et extraire les champs demandés. Les messages arrivent en français, arabe ou darija (dialecte marocain).

RÈGLES D'EXTRACTION — applique-les strictement:
- isOrder: true si le message est une demande d'achat claire, false pour questions/salutations/remerciements
- product: EXTRAIRE tout nom de produit mentionné (bougie, bouquet, parfum, rose éternelle, etc.). Si un produit est cité, ce champ NE DOIT PAS être null.
- quantity: nombre entier explicite, sinon 1 par défaut quand un produit est commandé
- address: EXTRAIRE toute ville ou adresse mentionnée. Mots-clés: "livraison", "adresse", "Casa", "Rabat", "Marrakech", "lmdina", etc.
- deliveryDate: EXTRAIRE toute mention de date ou jour. Exemples darija: "nhar lkhmis"=jeudi, "lhad"=dimanche, "ghda"/"demain"=demain, "juj ayam"=dans 2 jours, "had simana"=cette semaine.
- customerName: EXTRAIRE seulement si un prénom ou nom est explicitement mentionné, sinon null
- totalPrice: prix total si le client le mentionne, sinon null

EXEMPLES — message → JSON attendu:

"salam bghit 2 bougies vanille livraison Rabat nhar lkhmis"
→ {"isOrder":true,"customerName":null,"product":"bougies vanille","quantity":2,"address":"Rabat","deliveryDate":"nhar lkhmis","totalPrice":null}

"Bonjour je voudrais 1 bouquet roses éternelles, adresse Casa Maarif, livraison demain"
→ {"isOrder":true,"customerName":null,"product":"bouquet roses éternelles","quantity":1,"address":"Casa Maarif","deliveryDate":"demain","totalPrice":null}

"bghit bougie oud, Casa, ghda"
→ {"isOrder":true,"customerName":null,"product":"bougie oud","quantity":1,"address":"Casa","deliveryDate":"ghda","totalPrice":null}

"3andi tlb: juj bougies oud w wahd parfum rose, livraison Marrakech"
→ {"isOrder":true,"customerName":null,"product":"bougies oud et parfum rose","quantity":3,"address":"Marrakech","deliveryDate":null,"totalPrice":null}

"je veux commander bougies vanille pour Fatima, livraison Casablanca lhad"
→ {"isOrder":true,"customerName":"Fatima","product":"bougies vanille","quantity":1,"address":"Casablanca","deliveryDate":"lhad","totalPrice":null}

"wahd bouquet dial ward, t3awdili nhar lhad f Agadir"
→ {"isOrder":true,"customerName":null,"product":"bouquet ward","quantity":1,"address":"Agadir","deliveryDate":"nhar lhad","totalPrice":null}

"chhal taman dyal bougie lavande?"
→ {"isOrder":false,"customerName":null,"product":null,"quantity":null,"address":null,"deliveryDate":null,"totalPrice":null}

"salam" → {"isOrder":false,"customerName":null,"product":null,"quantity":null,"address":null,"deliveryDate":null,"totalPrice":null}

"fin kayn livreur dyalkom?" → {"isOrder":false,"customerName":null,"product":null,"quantity":null,"address":null,"deliveryDate":null,"totalPrice":null}

FORMAT DE SORTIE: JSON brut uniquement. Pas de markdown, pas de texte avant ou après, pas d'explication.`;

function extractJson(raw: string): string {
  const stripped = raw.replace(/```(?:json)?\n?|\n?```/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  return match ? match[0] : stripped;
}

function toStr(val: unknown): string | null {
  if (val === null || val === undefined || val === 'null' || val === '') return null;
  return typeof val === 'string' ? val : String(val);
}

function parseJsonSafe(text: string): ParsedOrder | null {
  try {
    const parsed = JSON.parse(extractJson(text));
    return {
      isOrder: !!parsed.isOrder,
      customerName: toStr(parsed.customerName),
      product: toStr(parsed.product),
      quantity: typeof parsed.quantity === 'number' && parsed.quantity > 0 ? parsed.quantity : null,
      address: toStr(parsed.address),
      deliveryDate: toStr(parsed.deliveryDate),
      totalPrice: typeof parsed.totalPrice === 'number' && parsed.totalPrice > 0 ? parsed.totalPrice : null,
    };
  } catch {
    return null;
  }
}

async function callClaude(messageText: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: messageText }],
  });
  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Non-text response');
  return content.text;
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

  console.warn('[llmParser] Parse failed after retry — falling back to null fields');
  return {
    isOrder: false,
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
