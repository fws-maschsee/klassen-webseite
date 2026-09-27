// Attrappe für `dist/server/entry.mjs`, die zurückgibt, was hinter Express ankommt.
export const handler = (req, res) => {
	res.statusCode = 200
	res.setHeader('content-type', 'application/json')
	res.end(
		JSON.stringify({ method: req.method, cookie: req.headers.cookie ?? null }),
	)
}
