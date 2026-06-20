/**
 * Download an audio file from `audioUrl` (optionally with a Bearer token)
 * and transcribe it with Groq Whisper. Returns the transcribed text, or a
 * fallback placeholder string when transcription is unavailable / fails.
 */
export declare function transcribeAudio(audioUrl: string, bearerToken?: string): Promise<string>;
/**
 * Resolve a Meta media ID to a downloadable URL.
 * Meta's Cloud API stores media by ID; we must fetch the URL first.
 */
export declare function resolveMetaMediaUrl(mediaId: string): Promise<string | null>;
//# sourceMappingURL=transcription.d.ts.map