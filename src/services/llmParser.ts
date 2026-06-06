import Anthropic from '@anthropic-ai/sdk';

// Lazy client — instantiated on first use so Railway env vars are guaranteed loaded
let _anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

export interface ParsedOrder {
  isOrder: boolean;
  customerName: string | null;
  product: string | null;
  quantity: number | null;
  address: string | null;
  deliveryDate: string | null;
  totalPrice: number | null;
}

function buildSystemPrompt(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MONTHS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  const todayISO = toISO(now);
  const todayFr = `${now.getDate()} ${MONTHS_FR[now.getMonth()]} ${now.getFullYear()}`;

  const addDays = (n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return toISO(d); };
  const nextWeekday = (target: number) => {
    let diff = (target - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(diff);
  };

  return `Tu es un extracteur de données pour commandes d'une boutique marocaine (tout type de produit).

IMPORTANT — Date d'aujourd'hui: ${todayISO} (${todayFr})

TÂCHE: Analyser le message et extraire les champs demandés. Les messages arrivent en français, arabe ou darija (dialecte marocain).

RÈGLES D'EXTRACTION — applique-les strictement:
- isOrder: true dès que le message exprime un désir d'acheter ou commander un produit, quelle que soit la catégorie. Mots-clés qui déclenchent TOUJOURS isOrder=true: "je voudrais", "je veux", "bghit", "nreed", "commander", "acheter", "commande", "livraison" + produit, "bghit nchri", "3tini", "عطيني", "بغيت". isOrder=false uniquement pour questions pures (prix, horaires), salutations seules, ou remerciements sans produit.
- product: EXTRAIRE tout nom de produit ou plat mentionné, quelle que soit la catégorie (nourriture, cadeaux, vêtements, etc.). Si un produit est cité, ce champ NE DOIT PAS être null.
- quantity: nombre entier explicite, sinon 1 par défaut quand un produit est commandé
- address: EXTRAIRE toute ville ou adresse mentionnée. Mots-clés: "livraison", "adresse", "Casa", "Rabat", "Marrakech", "lmdina", etc.
- deliveryDate: EXTRAIRE et CONVERTIR toute mention de date ou délai en format ISO YYYY-MM-DD. Correspondances basées sur aujourd'hui (${todayISO}):
  • "demain" / "ghda" / "l-ghda" → ${addDays(1)}
  • "après-demain" / "ba3d ghda" → ${addDays(2)}
  • "dans 2 jours" / "juj ayam" → ${addDays(2)}
  • "dans 3 jours" / "tlata ayam" → ${addDays(3)}
  • "cette semaine" / "had simana" → ${addDays(5)}
  • "semaine prochaine" / "simana jaya" → ${addDays(7)}
  • "lundi" / "nhar ltnin" → ${nextWeekday(1)}
  • "mardi" / "nhar tlt" → ${nextWeekday(2)}
  • "mercredi" / "nhar larb3" → ${nextWeekday(3)}
  • "jeudi" / "nhar lkhmis" → ${nextWeekday(4)}
  • "vendredi" / "nhar jm3a" → ${nextWeekday(5)}
  • "samedi" / "nhar sbt" → ${nextWeekday(6)}
  • "dimanche" / "lhad" / "nhar lhad" → ${nextWeekday(0)}
  • Date "7 juin" sans année → ${now.getFullYear()}-06-07 (si déjà passée, utilise ${now.getFullYear() + 1}-06-07)
  • Date avec année explicite "7 juin 2027" → 2027-06-07
  Si aucune date mentionnée → null
- customerName: EXTRAIRE seulement si un prénom ou nom est explicitement mentionné, sinon null
- totalPrice: prix total si le client le mentionne, sinon null

EXEMPLES — message → JSON attendu (avec la date du jour actuelle):

"bghit 2 poulets rôtis livraison Casa"
→ {"isOrder":true,"customerName":null,"product":"poulet rôti","quantity":2,"address":"Casablanca","deliveryDate":null,"totalPrice":null}

"salam bghit 2 bougies vanille livraison Rabat nhar lkhmis"
→ {"isOrder":true,"customerName":null,"product":"bougies vanille","quantity":2,"address":"Rabat","deliveryDate":"${nextWeekday(4)}","totalPrice":null}

"Bonjour je voudrais 1 bouquet roses éternelles, adresse Casa Maarif, livraison demain"
→ {"isOrder":true,"customerName":null,"product":"bouquet roses éternelles","quantity":1,"address":"Casa Maarif","deliveryDate":"${addDays(1)}","totalPrice":null}

"bghit bougie oud, Casa, ghda"
→ {"isOrder":true,"customerName":null,"product":"bougie oud","quantity":1,"address":"Casa","deliveryDate":"${addDays(1)}","totalPrice":null}

"3andi tlb: juj sandwichs w wahd jus orange, livraison Marrakech"
→ {"isOrder":true,"customerName":null,"product":"sandwichs et jus orange","quantity":3,"address":"Marrakech","deliveryDate":null,"totalPrice":null}

"je veux commander une robe pour Fatima, livraison Casablanca lhad"
→ {"isOrder":true,"customerName":"Fatima","product":"robe","quantity":1,"address":"Casablanca","deliveryDate":"${nextWeekday(0)}","totalPrice":null}

"wahd bouquet dial ward, t3awdili nhar lhad f Agadir"
→ {"isOrder":true,"customerName":null,"product":"bouquet ward","quantity":1,"address":"Agadir","deliveryDate":"${nextWeekday(0)}","totalPrice":null}

"chhal taman dyal poulet rôti?"
→ {"isOrder":false,"customerName":null,"product":null,"quantity":null,"address":null,"deliveryDate":null,"totalPrice":null}

"salam" → {"isOrder":false,"customerName":null,"product":null,"quantity":null,"address":null,"deliveryDate":null,"totalPrice":null}

"fin kayn livreur dyalkom?" → {"isOrder":false,"customerName":null,"product":null,"quantity":null,"address":null,"deliveryDate":null,"totalPrice":null}

FORMAT DE SORTIE: JSON brut uniquement. Pas de markdown, pas de texte avant ou après, pas d'explication.`;
}

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

const MODEL = 'claude-haiku-4-5-20251001';

async function callClaude(messageText: string): Promise<string> {
  const messages = [{ role: 'user' as const, content: messageText }];

  console.log('[llmParser] callClaude —', JSON.stringify({
    apiKeyExists: !!process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    messages,
  }));

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 256,
      system: buildSystemPrompt(),
      messages,
    });
    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Non-text response');
    return content.text;
  } catch (err: unknown) {
    const status = (err as Record<string, unknown>)?.status;
    const errBody = (err as Record<string, unknown>)?.error;
    console.error('[llmParser] Anthropic API error — status:', status, '— body:', JSON.stringify(errBody));
    throw err;
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

  console.warn('[llmParser] Parse failed after retry — falling back to preserve message as order');
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

// ── Conversation-level parser (called after merchant trigger) ─────────────────

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

function buildConversationSystemPrompt(): string {
  const today = new Date().toISOString().split('T')[0];
  return `Tu es un assistant qui extrait les informations de commande depuis une conversation WhatsApp entre un marchand et son client.

La date d'aujourd'hui est: ${today}

Analyse TOUTE la conversation et extrait:
- customerName: nom du client (null si non mentionné)
- phone: téléphone du client (null si non mentionné)
- product: produit commandé (si photo sans nom → "À préciser", null si aucun produit)
- quantity: quantité (défaut: 1 si un produit est identifié, sinon null)
- address: adresse de livraison (null si non mentionnée)
- deliveryDate: date de livraison en format ISO YYYY-MM-DD (null si non mentionnée)
- price: prix total si mentionné (null sinon)
- confidence: score de 0 à 100 sur la certitude que c'est bien une commande complète
  • 90-100: produit + adresse + tous les détails clés présents
  • 50-89: commande probable mais infos partielles (ex: pas d'adresse)
  • 0-49: trop d'infos manquantes ou conversation ambiguë

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après. Si une info est manquante → null.`;
}

function parseConversationJsonSafe(text: string): ParsedConversationOrder | null {
  try {
    const stripped = text.replace(/```(?:json)?\n?|\n?```/g, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    const raw = JSON.parse(match ? match[0] : stripped);
    return {
      customerName: toStr(raw.customerName),
      phone: toStr(raw.phone),
      product: toStr(raw.product),
      quantity: typeof raw.quantity === 'number' && raw.quantity > 0 ? raw.quantity : null,
      address: toStr(raw.address),
      deliveryDate: toStr(raw.deliveryDate),
      price: typeof raw.price === 'number' && raw.price > 0 ? raw.price : null,
      confidence: typeof raw.confidence === 'number' ? Math.min(100, Math.max(0, raw.confidence)) : 0,
    };
  } catch {
    return null;
  }
}

export async function parseOrderFromConversation(formattedConversation: string): Promise<ParsedConversationOrder> {
  const system = buildConversationSystemPrompt();
  const userMessage = `Voici la conversation complète:\n${formattedConversation}\n\nExtrait les informations de commande.`;

  console.log('[llmParser] parseOrderFromConversation — conversation length:', formattedConversation.length);

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });
    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Non-text response');

    const parsed = parseConversationJsonSafe(content.text);
    if (parsed) return parsed;

    console.warn('[llmParser] Invalid JSON from conversation parse, retrying...');
    const retry = await getClient().messages.create({
      model: MODEL,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });
    const retryContent = retry.content[0];
    if (retryContent.type !== 'text') throw new Error('Non-text response on retry');
    const retryParsed = parseConversationJsonSafe(retryContent.text);
    if (retryParsed) return retryParsed;
  } catch (err) {
    console.error('[llmParser] Conversation parse error:', err);
  }

  console.warn('[llmParser] Conversation parse failed — returning zero confidence');
  return { customerName: null, phone: null, product: null, quantity: null, address: null, deliveryDate: null, price: null, confidence: 0 };
}
