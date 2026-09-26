import type { APIRoute } from 'astro'
import { handleLogout } from '../../server/auth/oidc.ts'

export const GET: APIRoute = ({ request }) => handleLogout(request)
export const POST: APIRoute = ({ request }) => handleLogout(request)
