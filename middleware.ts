import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createMiddlewareClient({ req, res });
  // Rafraîchit la session si nécessaire, en mettant à jour les cookies
  await supabase.auth.getSession();
  return res;
}

// Évite d'exécuter le middleware sur les assets statiques et images Next
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
