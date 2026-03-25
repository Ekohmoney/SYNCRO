import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  }
}

export const supabase = createClient(supabaseUrl || 'http://localhost', supabaseServiceKey || 'test-key', {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

