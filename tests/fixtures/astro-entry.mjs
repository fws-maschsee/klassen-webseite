export const handler = (_req, res) => {
	res.statusCode = 200
	res.setHeader('content-type', 'text/plain; charset=utf-8')
	res.end('astro-fixture')
}
