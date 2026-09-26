import type { APIRoute } from 'astro'
import { startLogin } from '../../server/auth/oidc.ts'

export const GET: APIRoute = ({ request, url }) =>
	startLogin(request, url.searchParams.get('rd') ?? '/')
