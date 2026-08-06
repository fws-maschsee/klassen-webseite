/**
 * Steht fuer `dist/server/entry.mjs` aus dem Astro-Build einer Klasse.
 *
 * `startServer()` haengt diesen Handler als letztes in Express ein. Fuer den
 * Starttest zaehlt nur, DASS er drankommt — ein echter Astro-Build waere hier
 * eine zweite Toolchain fuer eine Zeile Aussage.
 */
export const handler = (_req, res) => {
	res.statusCode = 200
	res.setHeader('content-type', 'text/plain; charset=utf-8')
	res.end('astro-fixture')
}
