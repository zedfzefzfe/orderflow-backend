import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

// Supabase is now used ONLY for media storage (automation photos/videos/audio).
// Auth has moved to the backend's own JWT system (see src/routes/auth.ts).
// During the storage migration these env vars may be absent — in that case we
// export a safe stub so the server still boots, and only throw if storage is
// actually used.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const wsOptions = { realtime: { transport: ws } } as Parameters<typeof createClient>[2];

const storageNotConfigured = () => {
  throw new Error(
    'Media storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).',
  );
};

export const supabaseAdmin: SupabaseClient =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, wsOptions)
    : (new Proxy({}, { get: storageNotConfigured }) as SupabaseClient);

export const supabaseClient = (token: string) => {
  if (!supabaseUrl || !process.env.SUPABASE_ANON_KEY) storageNotConfigured();
  return createClient(supabaseUrl!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
};
