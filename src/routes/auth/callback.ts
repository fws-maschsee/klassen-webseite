import type { APIRoute } from 'astro'
import { handleCallback } from '../../server/auth/oidc.ts'

// Eigene Route statt Sonderfall in der Middleware: im Express-Modus ruft Astro seine
// Middleware nur für Pfade mit Route, sonst antwortet Express „Cannot GET“.
export const GET: APIRoute = ({ request }) => handleCallback(request)
