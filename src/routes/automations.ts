import { Router, Response } from 'express';
import multer from 'multer';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { stripForMatch } from '../utils/triggerMatch.js';

const router = Router();

// ── Photo upload config ───────────────────────────────────────────────────────

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 10;
const BUCKET = 'whatsapp-bouquets';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('TYPE_ERROR'));
    }
  },
});

// ── Document upload config ────────────────────────────────────────────────────

const DOC_MIME = 'application/pdf';
const MAX_DOC_BYTES = 16 * 1024 * 1024; // 16 MB
const MAX_DOCS = 2;
const DOC_BUCKET = 'whatsapp-documents';

const uploadDocs = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES, files: MAX_DOCS },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === DOC_MIME) {
      cb(null, true);
    } else {
      cb(new Error('TYPE_ERROR'));
    }
  },
});

// ── Video upload config ───────────────────────────────────────────────────────

const VIDEO_MIME = 'video/mp4';
// WhatsApp stops playing video inline past ~16 MB, so refuse it up front.
// This is a per-file cap and must stay 16 MB however many videos are allowed.
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEOS = 3;
const VIDEO_BUCKET = 'whatsapp-videos';

const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: MAX_VIDEOS },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === VIDEO_MIME) {
      cb(null, true);
    } else {
      cb(new Error('TYPE_ERROR'));
    }
  },
});

// ── Audio upload config ───────────────────────────────────────────────────────

// Evolution transcodes to OGG/Opus on send, so accept what a phone records.
const AUDIO_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/opus',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/wav', 'audio/webm',
]);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // 16 MB, same WhatsApp media ceiling
const MAX_AUDIOS = 2;
const AUDIO_BUCKET = 'whatsapp-audio';

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: MAX_AUDIOS },
  fileFilter: (_req, file, cb) => {
    if (AUDIO_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('TYPE_ERROR'));
    }
  },
});

// ── Payload validation ────────────────────────────────────────────────────────

interface AutomationPayload {
  name: string;
  triggerMessage: string;
  welcomeMessage: string;
  photoUrls: string[];
  videoUrl: string | null;
  videoUrls: string[];
  documentUrls: string[];
  message2: string | null;
  message3: string | null;
  audioUrls: string[];
  isActive: boolean;
  priority: number;
}

// Returns a validated payload, or an error message describing the first problem.
// `partial` mode (PUT) only validates the fields actually present in the body.
// `current` is the stored row on PUT — used to stop a legacy single-video save
// from truncating an automation that already holds several videos.
function validatePayload(
  body: Record<string, unknown>,
  partial: boolean,
  current?: { videoUrls: string[] },
): { data: Partial<AutomationPayload> } | { error: string } {
  const data: Partial<AutomationPayload> = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'name est requis' };
    data.name = name;
  }

  if (body.triggerMessage !== undefined || !partial) {
    const triggerMessage = String(body.triggerMessage ?? '').trim();
    if (!triggerMessage) return { error: 'triggerMessage est requis' };
    // A trigger made only of emojis/punctuation normalizes to an empty string,
    // which would match every incoming message. The webhook skips such rows, so
    // reject them here rather than silently saving a rule that never fires.
    if (!stripForMatch(triggerMessage)) {
      return {
        error:
          'triggerMessage doit contenir des lettres ou des chiffres '
          + '(un déclencheur uniquement composé d\'emojis ou de ponctuation ne peut pas être détecté)',
      };
    }
    data.triggerMessage = triggerMessage;
  }

  if (body.welcomeMessage !== undefined || !partial) {
    const welcomeMessage = String(body.welcomeMessage ?? '').trim();
    if (!welcomeMessage) return { error: 'welcomeMessage est requis' };
    data.welcomeMessage = welcomeMessage;
  }

  if (body.photoUrls !== undefined) {
    if (!Array.isArray(body.photoUrls)) {
      return { error: 'photoUrls doit être un tableau d\'URLs' };
    }
    data.photoUrls = body.photoUrls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map(u => u.trim());
  } else if (!partial) {
    data.photoUrls = [];
  }

  // videoUrls is the source of truth. videoUrl is the legacy single-video field
  // the dashboard still sends; both are written so either side stays readable.
  if (body.videoUrls !== undefined) {
    if (!Array.isArray(body.videoUrls)) {
      return { error: 'videoUrls doit être un tableau d\'URLs' };
    }
    if (body.videoUrls.length > MAX_VIDEOS) {
      return { error: `videoUrls ne peut pas dépasser ${MAX_VIDEOS} vidéos` };
    }
    data.videoUrls = body.videoUrls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map(u => u.trim());
    data.videoUrl = data.videoUrls[0] ?? null;
  } else if (body.videoUrl !== undefined) {
    // Legacy path. A dashboard that only knows one video would otherwise wipe
    // videos 2 and 3 on every save, so ignore it once several are stored.
    if ((current?.videoUrls.length ?? 0) > 1) {
      console.warn('[automations] legacy videoUrl ignored — automation holds several videos');
    } else if (body.videoUrl === null) {
      data.videoUrl = null;
      data.videoUrls = [];
    } else if (typeof body.videoUrl === 'string') {
      const url = body.videoUrl.trim();
      data.videoUrl = url || null;
      data.videoUrls = url ? [url] : [];
    } else {
      return { error: 'videoUrl doit être une URL ou null' };
    }
  } else if (!partial) {
    data.videoUrl = null;
    data.videoUrls = [];
  }

  // A shorter array than the stored one is how a document gets removed
  if (body.documentUrls !== undefined) {
    if (!Array.isArray(body.documentUrls)) {
      return { error: 'documentUrls doit être un tableau d\'URLs' };
    }
    if (body.documentUrls.length > MAX_DOCS) {
      return { error: `documentUrls ne peut pas dépasser ${MAX_DOCS} fichiers` };
    }
    data.documentUrls = body.documentUrls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map(u => u.trim());
  } else if (!partial) {
    data.documentUrls = [];
  }

  // Optional follow-ups sent after the media. Blank or null clears them, and a
  // cleared follow-up is simply skipped at send time.
  for (const field of ['message2', 'message3'] as const) {
    if (body[field] !== undefined) {
      if (body[field] === null) {
        data[field] = null;
      } else if (typeof body[field] === 'string') {
        data[field] = (body[field] as string).trim() || null;
      } else {
        return { error: `${field} doit être un texte ou null` };
      }
    } else if (!partial) {
      data[field] = null;
    }
  }

  // A shorter array than the stored one is how a voice note gets removed
  if (body.audioUrls !== undefined) {
    if (!Array.isArray(body.audioUrls)) {
      return { error: 'audioUrls doit être un tableau d\'URLs' };
    }
    if (body.audioUrls.length > MAX_AUDIOS) {
      return { error: `audioUrls ne peut pas dépasser ${MAX_AUDIOS} audios` };
    }
    data.audioUrls = body.audioUrls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map(u => u.trim());
  } else if (!partial) {
    data.audioUrls = [];
  }

  if (body.isActive !== undefined) {
    data.isActive = Boolean(body.isActive);
  }

  if (body.priority !== undefined) {
    const priority = Number(body.priority);
    if (!Number.isInteger(priority)) {
      return { error: 'priority doit être un entier' };
    }
    data.priority = priority;
  }

  return { data };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

// GET /api/automations — same order the webhook evaluates them in
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const automations = await prisma.automation.findMany({
      where: { businessId: req.user!.businessId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    res.json(automations);
  } catch (err) {
    console.error('[automations] list error:', err);
    res.status(500).json({ error: 'Impossible de charger les automations' });
  }
});

// POST /api/automations
router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = validatePayload(req.body ?? {}, false);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }

    const automation = await prisma.automation.create({
      data: {
        businessId: req.user!.businessId,
        name: result.data.name!,
        triggerMessage: result.data.triggerMessage!,
        welcomeMessage: result.data.welcomeMessage!,
        photoUrls: result.data.photoUrls ?? [],
        videoUrl: result.data.videoUrl ?? null,
        videoUrls: result.data.videoUrls ?? [],
        documentUrls: result.data.documentUrls ?? [],
        message2: result.data.message2 ?? null,
        message3: result.data.message3 ?? null,
        audioUrls: result.data.audioUrls ?? [],
        isActive: result.data.isActive ?? true,
        priority: result.data.priority ?? 0,
      },
    });

    res.status(201).json(automation);
  } catch (err) {
    console.error('[automations] create error:', err);
    res.status(500).json({ error: 'Impossible de créer l\'automation' });
  }
});

// PUT /api/automations/:id
router.put('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Tenant scope check first — a foreign id must look identical to a missing one
    const existing = await prisma.automation.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Automation introuvable' });
      return;
    }

    const result = validatePayload(req.body ?? {}, true, existing);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }

    const updated = await prisma.automation.update({
      where: { id },
      data: result.data,
    });

    res.json(updated);
  } catch (err) {
    console.error('[automations] update error:', err);
    res.status(500).json({ error: 'Impossible de modifier l\'automation' });
  }
});

// DELETE /api/automations/:id
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.automation.findFirst({
      where: { id, businessId: req.user!.businessId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Automation introuvable' });
      return;
    }

    // Photos are intentionally left in Supabase Storage: the same URL may be
    // referenced by another automation, and orphaned files are harmless.
    await prisma.automation.delete({ where: { id } });

    res.json({ ok: true });
  } catch (err) {
    console.error('[automations] delete error:', err);
    res.status(500).json({ error: 'Impossible de supprimer l\'automation' });
  }
});

// ── Photo upload ──────────────────────────────────────────────────────────────

// POST /api/automations/:id/photos — multipart field name: "photos" (repeatable)
router.post(
  '/:id/photos',
  requireAuth,
  (req: AuthenticatedRequest, res: Response, next) => {
    upload.array('photos', MAX_FILES)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'Fichier trop volumineux (max 5 Mo)' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({ error: `Trop de fichiers (max ${MAX_FILES})` });
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: 'Le champ du formulaire doit s\'appeler "photos"' });
          return;
        }
      }
      if (err instanceof Error && err.message === 'TYPE_ERROR') {
        res.status(400).json({ error: 'Type de fichier non accepté (jpeg, png, webp, gif uniquement)' });
        return;
      }
      if (err) {
        res.status(400).json({ error: 'Erreur lors de la réception des fichiers' });
        return;
      }
      next();
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { businessId } = req.user!;

      const existing = await prisma.automation.findFirst({
        where: { id, businessId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Automation introuvable' });
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Aucun fichier reçu' });
        return;
      }

      // Ensure the bucket exists (creates silently if already present)
      await supabaseAdmin.storage.createBucket(BUCKET, { public: true }).catch(() => {});

      const urls: string[] = [];
      for (const file of files) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        // businessId prefix keeps one tenant's files out of another's folder
        const path = `${businessId}/${id}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

        if (uploadError) {
          console.error('[automations] Supabase upload error:', uploadError);
          res.status(500).json({ error: 'Échec du téléversement vers Supabase Storage' });
          return;
        }

        const { data: { publicUrl } } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
        urls.push(publicUrl);
      }

      // Append rather than replace, and return the updated row so the client can
      // use automation.photoUrls as the source of truth without a second PUT.
      const automation = await prisma.automation.update({
        where: { id },
        data: { photoUrls: { push: urls } },
      });

      res.status(201).json({ urls, automation });
    } catch (err) {
      console.error('[automations] photos upload error:', err);
      res.status(500).json({ error: 'Erreur interne lors du téléversement' });
    }
  },
);

// ── Document upload ───────────────────────────────────────────────────────────

// POST /api/automations/:id/documents — multipart field name: "documents"
router.post(
  '/:id/documents',
  requireAuth,
  (req: AuthenticatedRequest, res: Response, next) => {
    uploadDocs.array('documents', MAX_DOCS)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'Fichier trop volumineux (max 16 Mo)' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({ error: `Trop de fichiers (max ${MAX_DOCS})` });
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: 'Le champ du formulaire doit s\'appeler "documents"' });
          return;
        }
      }
      if (err instanceof Error && err.message === 'TYPE_ERROR') {
        res.status(400).json({ error: 'Type de fichier non accepté (PDF uniquement)' });
        return;
      }
      if (err) {
        res.status(400).json({ error: 'Erreur lors de la réception des fichiers' });
        return;
      }
      next();
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { businessId } = req.user!;

      const existing = await prisma.automation.findFirst({
        where: { id, businessId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Automation introuvable' });
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Aucun fichier reçu' });
        return;
      }

      // multer caps a single request; this caps the total already stored
      if (existing.documentUrls.length + files.length > MAX_DOCS) {
        const left = MAX_DOCS - existing.documentUrls.length;
        res.status(400).json({
          error: left > 0
            ? `${MAX_DOCS} PDF maximum — il reste ${left} emplacement${left > 1 ? 's' : ''}`
            : `${MAX_DOCS} PDF maximum — supprimez-en un d'abord`,
        });
        return;
      }

      await supabaseAdmin.storage
        .createBucket(DOC_BUCKET, { public: true, fileSizeLimit: MAX_DOC_BYTES })
        .catch(() => {});

      const urls: string[] = [];
      for (const file of files) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${businessId}/${id}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from(DOC_BUCKET)
          .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

        if (uploadError) {
          console.error('[automations] Supabase document upload error:', uploadError);
          res.status(500).json({ error: 'Échec du téléversement vers Supabase Storage' });
          return;
        }

        const { data: { publicUrl } } = supabaseAdmin.storage.from(DOC_BUCKET).getPublicUrl(path);
        urls.push(publicUrl);
      }

      const automation = await prisma.automation.update({
        where: { id },
        data: { documentUrls: { push: urls } },
      });

      res.status(201).json({ urls: automation.documentUrls, automation });
    } catch (err) {
      console.error('[automations] documents upload error:', err);
      res.status(500).json({ error: 'Erreur interne lors du téléversement' });
    }
  },
);

// ── Video upload ──────────────────────────────────────────────────────────────

// POST /api/automations/:id/video — multipart field name: "video" (repeatable)
router.post(
  '/:id/video',
  requireAuth,
  (req: AuthenticatedRequest, res: Response, next) => {
    uploadVideo.array('video', MAX_VIDEOS)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'Vidéo trop volumineuse (max 16 Mo par fichier — limite WhatsApp)' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({ error: `${MAX_VIDEOS} vidéos maximum par automation` });
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: 'Le champ du formulaire doit s\'appeler "video"' });
          return;
        }
      }
      if (err instanceof Error && err.message === 'TYPE_ERROR') {
        res.status(400).json({ error: 'Type de fichier non accepté (MP4 uniquement)' });
        return;
      }
      if (err) {
        res.status(400).json({ error: 'Erreur lors de la réception du fichier' });
        return;
      }
      next();
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { businessId } = req.user!;

      const existing = await prisma.automation.findFirst({
        where: { id, businessId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Automation introuvable' });
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Aucun fichier reçu' });
        return;
      }

      // multer caps a single request; this caps the total already stored
      if (existing.videoUrls.length + files.length > MAX_VIDEOS) {
        const left = MAX_VIDEOS - existing.videoUrls.length;
        res.status(400).json({
          error: left > 0
            ? `${MAX_VIDEOS} vidéos maximum — il reste ${left} emplacement${left > 1 ? 's' : ''}`
            : `${MAX_VIDEOS} vidéos maximum — supprimez-en une d'abord`,
        });
        return;
      }

      await supabaseAdmin.storage
        .createBucket(VIDEO_BUCKET, { public: true, fileSizeLimit: MAX_VIDEO_BYTES })
        .catch(() => {});

      const urls: string[] = [];
      for (const file of files) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${businessId}/${id}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from(VIDEO_BUCKET)
          .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

        if (uploadError) {
          console.error('[automations] Supabase video upload error:', uploadError);
          res.status(500).json({ error: 'Échec du téléversement vers Supabase Storage' });
          return;
        }

        const { data: { publicUrl } } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path);
        urls.push(publicUrl);
      }

      // Appended, like photos and documents. Old files stay in Storage.
      // videoUrl tracks the first entry so the current dashboard still sees one.
      const automation = await prisma.automation.update({
        where: { id },
        data: {
          videoUrls: { push: urls },
          videoUrl: existing.videoUrls[0] ?? urls[0],
        },
      });

      res.status(201).json({ urls: automation.videoUrls, automation });
    } catch (err) {
      console.error('[automations] video upload error:', err);
      res.status(500).json({ error: 'Erreur interne lors du téléversement' });
    }
  },
);

// ── Audio upload ──────────────────────────────────────────────────────────────

// POST /api/automations/:id/audio — multipart field name: "audio" (repeatable)
router.post(
  '/:id/audio',
  requireAuth,
  (req: AuthenticatedRequest, res: Response, next) => {
    uploadAudio.array('audio', MAX_AUDIOS)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'Audio trop volumineux (max 16 Mo par fichier)' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({ error: `${MAX_AUDIOS} audios maximum par automation` });
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: 'Le champ du formulaire doit s\'appeler "audio"' });
          return;
        }
      }
      if (err instanceof Error && err.message === 'TYPE_ERROR') {
        res.status(400).json({ error: 'Type de fichier non accepté (mp3, ogg, m4a, wav, webm)' });
        return;
      }
      if (err) {
        res.status(400).json({ error: 'Erreur lors de la réception du fichier' });
        return;
      }
      next();
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { businessId } = req.user!;

      const existing = await prisma.automation.findFirst({
        where: { id, businessId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Automation introuvable' });
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Aucun fichier reçu' });
        return;
      }

      // multer caps a single request; this caps the total already stored
      if (existing.audioUrls.length + files.length > MAX_AUDIOS) {
        const left = MAX_AUDIOS - existing.audioUrls.length;
        res.status(400).json({
          error: left > 0
            ? `${MAX_AUDIOS} audios maximum — il reste ${left} emplacement`
            : `${MAX_AUDIOS} audios maximum — supprimez-en un d'abord`,
        });
        return;
      }

      await supabaseAdmin.storage
        .createBucket(AUDIO_BUCKET, { public: true, fileSizeLimit: MAX_AUDIO_BYTES })
        .catch(() => {});

      const urls: string[] = [];
      for (const file of files) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${businessId}/${id}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from(AUDIO_BUCKET)
          .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

        if (uploadError) {
          console.error('[automations] Supabase audio upload error:', uploadError);
          res.status(500).json({ error: 'Échec du téléversement vers Supabase Storage' });
          return;
        }

        const { data: { publicUrl } } = supabaseAdmin.storage.from(AUDIO_BUCKET).getPublicUrl(path);
        urls.push(publicUrl);
      }

      // Appended, like videos. Old files stay in Storage.
      const automation = await prisma.automation.update({
        where: { id },
        data: { audioUrls: { push: urls } },
      });

      res.status(201).json({ urls: automation.audioUrls, automation });
    } catch (err) {
      console.error('[automations] audio upload error:', err);
      res.status(500).json({ error: 'Erreur interne lors du téléversement' });
    }
  },
);

export default router;
