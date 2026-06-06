import Groq, { toFile } from 'groq-sdk';

const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v18.0';

let _groq: Groq | null = null;

function getGroqClient(): Groq | null {
  if (!process.env.GROQ_API_KEY) return null;
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// Derive a file extension from a MIME type string.
function mimeToExt(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'mp4';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('wav')) return 'wav';
  return 'ogg'; // WhatsApp voice notes are almost always Opus/OGG
}

/**
 * Download an audio file from `audioUrl` (optionally with a Bearer token)
 * and transcribe it with Groq Whisper. Returns the transcribed text, or a
 * fallback placeholder string when transcription is unavailable / fails.
 */
export async function transcribeAudio(audioUrl: string, bearerToken?: string): Promise<string> {
  const groq = getGroqClient();
  if (!groq) {
    console.warn('[GROQ] No GROQ_API_KEY configured — returning placeholder');
    return '[Audio]';
  }

  try {
    console.log('[GROQ] Downloading audio from:', audioUrl);

    const headers: Record<string, string> = {};
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

    const response = await fetch(audioUrl, { headers });
    if (!response.ok) {
      throw new Error(`Audio download failed: ${response.status} ${response.statusText}`);
    }

    // Strip codec parameters — "audio/ogg; codecs=opus" → "audio/ogg"
    const rawMime = response.headers.get('content-type') || 'audio/ogg';
    const mimeType = rawMime.split(';')[0].trim();
    const ext = mimeToExt(mimeType);
    console.log('[GROQ] Audio content-type:', rawMime, '→ using:', mimeType, `(${ext})`);
    const audioBuffer = await response.arrayBuffer();
    const audioFile = await toFile(Buffer.from(audioBuffer), `audio.${ext}`, { type: mimeType });

    console.log('[GROQ] Audio transcription started');

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      language: 'fr',
      response_format: 'text',
    });

    // response_format: 'text' returns a plain string at runtime even though
    // TypeScript types it as Transcription — cast safely.
    const text = (typeof transcription === 'string'
      ? transcription
      : (transcription as unknown as { text: string }).text ?? ''
    ).trim();

    console.log('[GROQ] Audio transcription completed:', text.substring(0, 100));
    return text || '[Audio - transcription vide]';

  } catch (err) {
    console.error('[GROQ] Transcription error:', err);
    return '[Audio - transcription échouée]';
  }
}

/**
 * Resolve a Meta media ID to a downloadable URL.
 * Meta's Cloud API stores media by ID; we must fetch the URL first.
 */
export async function resolveMetaMediaUrl(mediaId: string): Promise<string | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    console.warn('[GROQ] No WHATSAPP_ACCESS_TOKEN — cannot resolve Meta media URL');
    return null;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.error(`[GROQ] Meta media URL resolution failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as { url?: string };
    return data.url || null;
  } catch (err) {
    console.error('[GROQ] resolveMetaMediaUrl error:', err);
    return null;
  }
}
