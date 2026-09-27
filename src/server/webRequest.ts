import type { Request as ExpressRequest } from 'express'

export const kopfAlsWebRequest = (req: ExpressRequest): Request => {
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
