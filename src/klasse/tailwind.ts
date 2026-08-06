import { fileURLToPath } from 'node:url'

/**
 * Die Glob-Muster, unter denen Tailwind nach benutzten Klassen suchen muss.
 *
 * Ohne diesen Eintrag in der `tailwind.config.mjs` der Klasse baut die Seite
 * durch, sieht aber kaputt aus: Tailwind scannt standardmäßig nur `./src/**`
 * der Klasse, und die geteilten Seiten liegen unter `node_modules`. Jede
 * Utility-Klasse, die nur dort vorkommt, fehlt dann im CSS. Das ist ein Fehler,
 * den kein Build meldet — deshalb als Funktion mit absoluten Pfaden statt als
 * dokumentierter String, den jede Klasse abschreibt.
 */
export const tailwindContent = (): string[] => {
	const paketWurzel = fileURLToPath(new URL('../../', import.meta.url))
	return [
		`${paketWurzel}astro/**/*.{astro,ts,js}`,
		// shipyard liefert seine Komponenten ebenfalls als Quelle aus.
		'node_modules/@levino/shipyard-*/**/*.{astro,js,ts}',
	]
}
