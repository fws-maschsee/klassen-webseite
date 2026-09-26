import type { APIRoute } from 'astro'
import { handleZitadelWebhook } from '../../server/auth/webhook.ts'

export const prerender = false

export const POST: APIRoute = ({ request }) => handleZitadelWebhook(request)
