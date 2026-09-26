import type { APIRoute } from 'astro'
import { handleBackchannelLogout } from '../../server/auth/oidc.ts'

export const prerender = false

export const POST: APIRoute = ({ request }) => handleBackchannelLogout(request)
