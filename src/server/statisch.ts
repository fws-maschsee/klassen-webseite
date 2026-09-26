import fs from 'node:fs'
import path from 'node:path'
import type { RequestHandler } from 'express'
import {
	klassenConfig,
	PUBLIC_PATHS,
	wemGehoertDieSeite,
} from '../klasse/config.ts'
import { authenticate } from './auth/oidc.ts'

export const nurAngemeldet = (staticDir: string): RequestHandler => {
	const wurzel = path.resolve(staticDir)

	return (req, res, next) => {
		if (process.env.DISABLE_AUTH === 'true') {
			next()
			return
		}

		const pfad = req.path
		if (PUBLIC_PATHS.some((prefix) => pfad.startsWith(prefix))) {
			next()
			return
		}
		if (pfad.startsWith('/auth/')) {
			next()
			return
		}
		if (pfad.startsWith('/_astro/') && /\.(css|js|mjs|woff2?)$/.test(pfad)) {
			next()
			return
		}
		if (!istDatei(wurzel, pfad)) {
			next()
			return
		}

		void (async () => {
			try {
				const { contactMail } = klassenConfig()
				const { response } = await authenticate(alsWebRequest(req), {
					siteOwner: wemGehoertDieSeite(),
					contactMail,
				})
				if (response === null) {
					next()
					return
				}
				await schreibe(response, res)
			} catch (fehler) {
				console.error('[statisch] Anmeldepruefung fehlgeschlagen:', fehler)
				res
					.status(503)
					.type('text/plain; charset=utf-8')
					.send('Anmeldung nicht verfügbar')
			}
		})()
	}
}

const alsWebRequest = (req: Parameters<RequestHandler>[0]): Request => {
	const kopf = new Headers()
	for (const [name, wert] of Object.entries(req.headers)) {
		if (typeof wert === 'string') kopf.set(name, wert)
		else if (Array.isArray(wert)) for (const w of wert) kopf.append(name, w)
	}
	return new Request(
		new URL(
			req.originalUrl,
			`${req.protocol}://${req.get('host') ?? 'localhost'}`,
		),
		{ method: 'GET', headers: kopf },
	)
}

const schreibe = async (
	antwort: Response,
	res: Parameters<RequestHandler>[1],
): Promise<void> => {
	res.status(antwort.status)
	antwort.headers.forEach((wert, name) => {
		res.append(name, wert)
	})
	const rumpf = await antwort.arrayBuffer()
	res.send(Buffer.from(rumpf))
}

const istDatei = (wurzel: string, pfad: string): boolean => {
	let entpackt: string
	try {
		entpackt = decodeURIComponent(pfad)
	} catch {
		return false
	}

	const ziel = path.resolve(wurzel, `.${path.posix.normalize(entpackt)}`)
	if (ziel !== wurzel && !ziel.startsWith(wurzel + path.sep)) return false

	const eintrag = fs.statSync(ziel, { throwIfNoEntry: false })
	if (eintrag === undefined) return false
	if (eintrag.isFile()) return true
	if (!eintrag.isDirectory()) return false

	return (
		fs
			.statSync(path.join(ziel, 'index.html'), { throwIfNoEntry: false })
			?.isFile() === true
	)
}
