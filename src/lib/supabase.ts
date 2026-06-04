import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const wsOptions = { realtime: { transport: ws } } as Parameters<typeof createClient>[2];

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, wsOptions);

export const supabaseClient = (token: string) => {
  return createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
};
