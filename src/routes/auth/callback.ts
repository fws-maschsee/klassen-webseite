import type { APIRoute } from 'astro'
import { handleCallback } from '../../server/auth/oidc.ts'

export const GET: APIRoute = ({ request }) => handleCallback(request)
