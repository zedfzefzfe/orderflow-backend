import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { prisma } from '../lib/prisma.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    businessId: string;
    role: string;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user || !data.user.email) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    let dbUser = await prisma.user.findFirst({
      where: { email: data.user.email },
      include: { business: true },
    });

    // Auto-provision: create business + user for new Supabase sign-ups
    if (!dbUser) {
      const emailName = data.user.email.split('@')[0];
      const business = await prisma.business.create({
        data: { name: `${emailName}'s Shop` },
      });
      dbUser = await prisma.user.create({
        data: {
          email: data.user.email,
          password: '',
          businessId: business.id,
          role: 'owner',
        },
        include: { business: true },
      });
      console.log(`[auth] Auto-provisioned user ${data.user.email} → business ${business.id}`);
    }

    req.user = {
      id: dbUser.id,
      email: dbUser.email,
      businessId: dbUser.businessId,
      role: dbUser.role,
    };

    next();
  } catch (err) {
    console.error('[auth] Auth check failed:', err);
    res.status(500).json({ error: 'Auth check failed' });
  }
}
