import Anthropic from '@anthropic-ai/sdk';
// Lazy client — instantiated on first use so Railway env vars are guaranteed loaded
let _anthropic = null;
function getClient() {
    if (!_anthropic)
        _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _anthropic;
}
function buildSystemPrompt() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const todayISO = toISO(now);
    const todayFr = `${now.getDate()} ${MONTHS_FR[now.getMonth()]} ${now.getFullYear()}`;
    const addDays = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return toISO(d); };
    const nextWeekday = (target) => {
        let diff = (target - now.getDay() + 7) % 7;
        if (diff === 0)
            diff = 7;
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
function extractJson(raw) {
    const stripped = raw.replace(/```(?:json)?\n?|\n?```/g, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : stripped;
}
function toStr(val) {
    if (val === null || val === undefined || val === 'null' || val === '')
        return null;
    return typeof val === 'string' ? val : String(val);
}
function parseJsonSafe(text) {
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
    }
    catch {
        return null;
    }
}
const MODEL = 'claude-haiku-4-5-20251001';
async function callClaude(messageText) {
    const messages = [{ role: 'user', content: messageText }];
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
        if (content.type !== 'text')
            throw new Error('Non-text response');
        return content.text;
    }
    catch (err) {
        const status = err?.status;
        const errBody = err?.error;
        console.error('[llmParser] Anthropic API error — status:', status, '— body:', JSON.stringify(errBody));
        throw err;
    }
}
export async function parseOrderFromMessage(messageText) {
    try {
        const firstAttempt = parseJsonSafe(await callClaude(messageText));
        if (firstAttempt)
            return firstAttempt;
        console.warn('[llmParser] Invalid JSON on first attempt, retrying...');
        const secondAttempt = parseJsonSafe(await callClaude(messageText));
        if (secondAttempt)
            return secondAttempt;
    }
    catch (err) {
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
// ── Structured field extractor ─────────────────────────────────────────────────
const VALID_CATEGORIES = new Set([
    'BOUGIES_BOUQUETS', 'PARFUMS', 'VETEMENTS_MODE', 'COSMETIQUES_BEAUTE',
    'BIJOUX_ACCESSOIRES', 'DECORATION_MAISON', 'ELECTRONIQUE', 'ALIMENTATION',
    'SPORT_FITNESS', 'BEBE_ENFANT', 'AUTRE',
]);
const VALID_WILAYAS = new Set([
    'CASABLANCA', 'RABAT', 'MARRAKECH', 'FES', 'TANGER', 'AGADIR', 'MEKNES',
    'OUJDA', 'KENITRA', 'TETOUAN', 'SALE', 'TEMARA', 'MOHAMMEDIA', 'EL_JADIDA',
    'BENI_MELLAL', 'NADOR', 'SETTAT', 'KHOURIBGA', 'SAFI', 'LAAYOUNE', 'AUTRE',
]);
const VALID_DELIVERY_COMPANIES = new Set([
    'AMANA', 'MAYSTRO', 'OZONEXPRESS', 'CATHEDIS', 'SENDIT', 'TAWSSIL', 'AMEEX', 'AUTRE',
]);
const WILAYA_ALIASES = {
    'casablanca': 'CASABLANCA', 'casa': 'CASABLANCA', 'dar bida': 'CASABLANCA',
    'dar el bida': 'CASABLANCA', 'الدار البيضاء': 'CASABLANCA',
    'rabat': 'RABAT', 'الرباط': 'RABAT',
    'marrakech': 'MARRAKECH', 'marrakesh': 'MARRAKECH', 'mrakch': 'MARRAKECH', 'مراكش': 'MARRAKECH',
    'fes': 'FES', 'fez': 'FES', 'fès': 'FES', 'fas': 'FES', 'فاس': 'FES',
    'tanger': 'TANGER', 'tangier': 'TANGER', 'tanja': 'TANGER', 'طنجة': 'TANGER',
    'agadir': 'AGADIR', 'أكادير': 'AGADIR',
    'meknes': 'MEKNES', 'meknès': 'MEKNES', 'meknas': 'MEKNES', 'مكناس': 'MEKNES',
    'oujda': 'OUJDA', 'وجدة': 'OUJDA',
    'kenitra': 'KENITRA', 'kénitra': 'KENITRA', 'qnitra': 'KENITRA', 'القنيطرة': 'KENITRA',
    'tetouan': 'TETOUAN', 'tétouan': 'TETOUAN', 'tetuan': 'TETOUAN', 'تطوان': 'TETOUAN',
    'sale': 'SALE', 'salé': 'SALE', 'sala': 'SALE', 'سلا': 'SALE',
    'temara': 'TEMARA', 'témara': 'TEMARA', 'تمارة': 'TEMARA',
    'mohammedia': 'MOHAMMEDIA', 'mohammédia': 'MOHAMMEDIA', 'المحمدية': 'MOHAMMEDIA',
    'el jadida': 'EL_JADIDA', 'eljadida': 'EL_JADIDA', 'el-jadida': 'EL_JADIDA', 'الجديدة': 'EL_JADIDA',
    'beni mellal': 'BENI_MELLAL', 'benimellal': 'BENI_MELLAL', 'بني ملال': 'BENI_MELLAL',
    'nador': 'NADOR', 'الناظور': 'NADOR',
    'settat': 'SETTAT', 'سطات': 'SETTAT',
    'khouribga': 'KHOURIBGA', 'خريبكة': 'KHOURIBGA',
    'safi': 'SAFI', 'asfi': 'SAFI', 'آسفي': 'SAFI',
    'laayoune': 'LAAYOUNE', 'laâyoune': 'LAAYOUNE', 'laayoun': 'LAAYOUNE', 'العيون': 'LAAYOUNE',
};
function normalizeEnumVal(val, validSet) {
    if (!val || typeof val !== 'string')
        return null;
    const upper = val.trim().toUpperCase().replace(/[\s-]/g, '_');
    if (upper === 'NULL')
        return null;
    return validSet.has(upper) ? upper : null;
}
function normalizeWilayaVal(val) {
    if (!val || typeof val !== 'string' || val.toLowerCase() === 'null')
        return null;
    const upper = val.trim().toUpperCase().replace(/[\s-]/g, '_');
    if (VALID_WILAYAS.has(upper))
        return upper;
    const lower = val.trim().toLowerCase();
    return WILAYA_ALIASES[lower] ?? null;
}
const STRUCTURED_SYSTEM = `Tu extrais des métadonnées structurées depuis des données de commandes marocaines.

Extrait ces 4 champs:
- productCategory: parmi [BOUGIES_BOUQUETS, PARFUMS, VETEMENTS_MODE, COSMETIQUES_BEAUTE, BIJOUX_ACCESSOIRES, DECORATION_MAISON, ELECTRONIQUE, ALIMENTATION, SPORT_FITNESS, BEBE_ENFANT, AUTRE] — utilise AUTRE si ambigu
- wilaya: wilaya marocaine parmi [CASABLANCA, RABAT, MARRAKECH, FES, TANGER, AGADIR, MEKNES, OUJDA, KENITRA, TETOUAN, SALE, TEMARA, MOHAMMEDIA, EL_JADIDA, BENI_MELLAL, NADOR, SETTAT, KHOURIBGA, SAFI, LAAYOUNE, AUTRE] — normalise "casa"→CASABLANCA, "Rabat"→RABAT, "mrakch"→MARRAKECH, etc. Si pas de wilaya mentionnée → null
- city: quartier ou ville précis en texte libre (ex: "Hay Mohammadi", "Guéliz", "Agdal"), null si non mentionné
- deliveryCompany: société parmi [AMANA, MAYSTRO, OZONEXPRESS, CATHEDIS, SENDIT, TAWSSIL, AMEEX, AUTRE], null si non mentionnée

RÈGLES:
- wilaya non identifiable → null (jamais AUTRE par défaut)
- deliveryCompany non mentionnée → null (jamais AUTRE par défaut)
- productCategory ambigu → AUTRE

FORMAT: JSON brut uniquement, sans markdown.
{"productCategory":"...","wilaya":"...","city":"...","deliveryCompany":"..."}`;
export async function extractStructuredFields(product, address, rawMessage) {
    const fallback = { productCategory: null, wilaya: null, city: null, deliveryCompany: null };
    try {
        const input = `Produit: ${product}\nAdresse: ${address ?? '(non renseignée)'}\nMessage original: ${rawMessage.slice(0, 500)}`;
        const response = await getClient().messages.create({
            model: MODEL,
            max_tokens: 128,
            system: STRUCTURED_SYSTEM,
            messages: [{ role: 'user', content: input }],
        });
        const content = response.content[0];
        if (content.type !== 'text')
            return fallback;
        const match = content.text.replace(/```(?:json)?\n?|\n?```/g, '').trim().match(/\{[\s\S]*\}/);
        if (!match)
            return fallback;
        const parsed = JSON.parse(match[0]);
        return {
            productCategory: normalizeEnumVal(parsed.productCategory, VALID_CATEGORIES),
            wilaya: normalizeWilayaVal(parsed.wilaya),
            city: toStr(parsed.city),
            deliveryCompany: normalizeEnumVal(parsed.deliveryCompany, VALID_DELIVERY_COMPANIES),
        };
    }
    catch (err) {
        console.error('[llmParser] extractStructuredFields error:', err);
        return fallback;
    }
}
export async function classifyClientMessage(message) {
    const fallback = { name: null, address: null, date: null, phone: null };
    try {
        const response = await getClient().messages.create({
            model: MODEL,
            max_tokens: 150,
            messages: [{
                    role: 'user',
                    content: `Analyse ce message WhatsApp et extrait TOUTES les informations présentes.

Message: "${message}"

Réponds UNIQUEMENT en JSON:
{"name":"nom extrait ou null","address":"adresse extraite ou null","date":"date extraite ou null","phone":"téléphone extrait ou null"}

Exemples:
"Fatima Zahra, Casa Hay Mohammadi, samedi 8 juin" → {"name":"Fatima Zahra","address":"Casa Hay Mohammadi","date":"samedi 8 juin","phone":null}
"Karim" → {"name":"Karim","address":null,"date":null,"phone":null}
"Hay Mohammadi Casa" → {"name":null,"address":"Hay Mohammadi Casa","date":null,"phone":null}
"samedi" → {"name":null,"address":null,"date":"samedi","phone":null}
"wach kayna livraison gratuite?" → {"name":null,"address":null,"date":null,"phone":null}
"Fatima, 0661234567, Rabat, demain" → {"name":"Fatima","address":"Rabat","date":"demain","phone":"0661234567"}
"فاطمة الزهراء، حي المحمدي الدار البيضاء، السبت" → {"name":"فاطمة الزهراء","address":"حي المحمدي الدار البيضاء","date":"السبت","phone":null}

IMPORTANT: Respond ONLY with valid JSON. No markdown, no backticks.`,
                }],
        });
        const raw = response.content[0];
        if (raw.type !== 'text')
            return fallback;
        try {
            const cleanText = raw.text
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // remove control chars
                .trim();
            const jsonMatch = cleanText.match(/\{[^{}]*\}/);
            if (!jsonMatch)
                return fallback;
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                name: toStr(parsed.name),
                address: toStr(parsed.address),
                date: toStr(parsed.date),
                phone: toStr(parsed.phone),
            };
        }
        catch (error) {
            console.error('[llmParser] JSON parse error:', error.message);
            return fallback;
        }
    }
    catch (err) {
        console.error('[llmParser] classifyClientMessage error:', err);
        return fallback;
    }
}
function buildConversationSystemPrompt(contextNote = '') {
    const today = new Date().toISOString().split('T')[0];
    return `Tu es un assistant qui extrait les informations de commande depuis une conversation WhatsApp entre un marchand et son client.

La date d'aujourd'hui est: ${today}
${contextNote ? `\n${contextNote}\n` : ''}
Analyse TOUTE la conversation et extrait:
- customerName: nom du client (null si non mentionné)
- phone: téléphone du client (null si non mentionné)
- product: produit commandé (si photo sans nom → "À préciser", null si aucun produit)
- quantity: quantité (défaut: 1 si un produit est identifié, sinon null)
- address: adresse de livraison (null si non mentionnée)
- deliveryDate: date de livraison en format ISO YYYY-MM-DD (null si non mentionnée)
- price: prix total si mentionné (null sinon)
- confidence: score de 0 à 100 sur la certitude que c'est bien une commande complète
  • 80-100: produit + adresse + tous les détails clés présents
  • 35-79: commande probable mais infos partielles (ex: pas d'adresse, ou comblée par le contexte)
  • 0-34: trop d'infos manquantes ou conversation ambiguë

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après. Si une info est manquante → null.`;
}
function parseConversationJsonSafe(text) {
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
    }
    catch {
        return null;
    }
}
export async function parseOrderFromConversation(formattedConversation, contextNote = '') {
    const system = buildConversationSystemPrompt(contextNote);
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
        if (content.type !== 'text')
            throw new Error('Non-text response');
        const parsed = parseConversationJsonSafe(content.text);
        if (parsed)
            return parsed;
        console.warn('[llmParser] Invalid JSON from conversation parse, retrying...');
        const retry = await getClient().messages.create({
            model: MODEL,
            max_tokens: 512,
            system,
            messages: [{ role: 'user', content: userMessage }],
        });
        const retryContent = retry.content[0];
        if (retryContent.type !== 'text')
            throw new Error('Non-text response on retry');
        const retryParsed = parseConversationJsonSafe(retryContent.text);
        if (retryParsed)
            return retryParsed;
    }
    catch (err) {
        console.error('[llmParser] Conversation parse error:', err);
    }
    console.warn('[llmParser] Conversation parse failed — returning zero confidence');
    return { customerName: null, phone: null, product: null, quantity: null, address: null, deliveryDate: null, price: null, confidence: 0 };
}
//# sourceMappingURL=llmParser.js.map