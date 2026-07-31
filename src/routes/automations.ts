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

// ── Payload validation ────────────────────────────────────────────────────────

interface AutomationPayload {
  name: string;
  triggerMessage: string;
  welcomeMessage: string;
  photoUrls: string[];
  isActive: boolean;
  priority: number;
}

// Returns a validated payload, or an error message describing the first problem.
// `partial` mode (PUT) only validates the fields actually present in the body.
function validatePayload(
  body: Record<string, unknown>,
  partial: boolean,
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

    const result = validatePayload(req.body ?? {}, true);
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

export default router;
