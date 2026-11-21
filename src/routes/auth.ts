import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const JWT_EXPIRES_IN = '30d';

function signToken(user: { id: string; email: string; businessId: string; role: string }) {
  return jwt.sign(
    { userId: user.id, email: user.email, businessId: user.businessId, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

// POST /api/auth/register — create a business + owner user, return a JWT
router.post('/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const boutiqueName = String(req.body.boutiqueName || '').trim();
    const whatsappNumber = req.body.whatsappNumber ? String(req.body.whatsappNumber).trim() : null;

    if (!email || !password) {
      res.status(400).json({ error: 'Email et mot de passe requis' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    const business = await prisma.business.create({
      data: {
        name: boutiqueName || `${email.split('@')[0]}'s Shop`,
        email,
        ownerNotifyPhone: whatsappNumber,
        plan: 'trial',
        trialEndsAt,
      },
    });

    const user = await prisma.user.create({
      data: { email, password: hashed, businessId: business.id, role: 'owner' },
    });

    const token = signToken(user);
    console.log(`[auth] Registered ${email} → business ${business.id}`);
    res.json({
      token,
      user: { id: user.id, email: user.email, businessId: user.businessId, role: user.role },
    });
  } catch (err) {
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Échec de la création du compte' });
  }
});

// POST /api/auth/login — verify credentials, return a JWT
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      res.status(400).json({ error: 'Email et mot de passe requis' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      return;
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      return;
    }

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, email: user.email, businessId: user.businessId, role: user.role },
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Échec de la connexion' });
  }
});

// GET /api/auth/me — return the user encoded in the token
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as {
      userId: string; email: string; businessId: string; role: string;
    };
    res.json({
      user: {
        id: payload.userId,
        email: payload.email,
        businessId: payload.businessId,
        role: payload.role,
      },
    });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

export default router;
