import type { APIRoute } from 'astro'
import { handleLogout } from '../../server/auth/oidc.ts'

// GET für den Link in der Navigation, POST für das Formular der Abmelden-Seite.
export const GET: APIRoute = ({ request }) => handleLogout(request)
export const POST: APIRoute = ({ request }) => handleLogout(request)
