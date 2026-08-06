import { fileURLToPath } from 'node:url'

/**
 * Die geteilten Routen. Diese Liste ist der eigentliche Zweck des Packages:
 * eine neue Seite hier eintragen, Version taggen, in den Klassen die Version
 * heben — und die Seite ist in allen Klassen da, ohne dass in einem
 * Klassen-Repo eine Datei entsteht.
 *
 * `/docs`, `/blog` und die Seitenleisten kommen weiterhin von den
 * shipyard-Integrationen; hier stehen nur die Routen, die diese Anwendung
 * selbst mitbringt.
 */

/**
 * Paketwurzel, aufgelöst aus dem eigenen Modulpfad. Funktioniert sowohl aus
 * `dist/klasse/` (Regelfall beim Verbraucher) als auch aus `src/klasse/`
 * (dieses Repo unter `tsx`), weil beide zwei Ebenen unter der Wurzel liegen.
 */
const paketWurzel = new URL('../../', import.meta.url)

const paket = (relativ: string): string =>
	fileURLToPath(new URL(relativ, paketWurzel))

export type GeteilteRoute = {
	/** Astro-Routenmuster, wie es in `injectRoute` erwartet wird. */
	pattern: string
	/** Absoluter Pfad der Datei, die die Route bedient. */
	entrypoint: string
	/**
	 * Warum die Route ins Package gehört. Steht hier und nicht in der README,
	 * damit die Begründung mit der Route zusammen gepflegt wird.
	 */
	grund: string
}

/**
 * `.astro`-Dateien werden als Quelle ausgeliefert und von der Klassen-App
 * kompiliert; `.ts`-Routen liegen kompiliert in `dist/`, damit `tsc` sie
 * mitprüft. Beides zusammen ist der Grund für die zwei `files`-Einträge in
 * `package.json`.
 */
export const GETEILTE_ROUTEN: readonly GeteilteRoute[] = [
	{
		pattern: '/',
		entrypoint: paket('astro/pages/index.astro'),
		grund:
			'Startseite: verweist nur auf /docs, /blog und /verteiler — alles Routen, die es in jeder Klasse gibt.',
	},
	{
		pattern: '/logout',
		entrypoint: paket('astro/pages/logout.astro'),
		grund: 'Abmelde-Bestätigung. Reines Formular gegen /auth/logout.',
	},
	{
		pattern: '/verteiler',
		entrypoint: paket('astro/pages/verteiler/index.astro'),
		grund:
			'Mailverteiler-Übersicht aus der Datenbank. Enthält keine Adresse und keine Domain fest verdrahtet.',
	},
	{
		pattern: '/verwaltung',
		entrypoint: paket('astro/pages/verwaltung/index.astro'),
		grund:
			'Verwaltung von Verteilern, Gruppen, Adressbuch und MCP-Zugängen. Der aufwendigste Teil und genau der, den niemand zweimal pflegen will.',
	},
	{
		pattern: '/oauth/consent',
		entrypoint: paket('astro/pages/oauth/consent.astro'),
		grund: 'Zustimmungsseite des OAuth-Flows für MCP-Clients.',
	},
	{
		pattern: '/auth/login',
		entrypoint: paket('dist/routes/auth/login.js'),
		grund: 'Anmeldung anstoßen; `?rd=/pfad` merkt sich das Ziel danach.',
	},
	{
		pattern: '/auth/callback',
		entrypoint: paket('dist/routes/auth/callback.js'),
		grund:
			'Rücksprung von ZITADEL. Muss eine echte Route sein: im middleware-Modus ruft Astro seine Middleware nur für Pfade auf, zu denen es eine Route gibt.',
	},
	{
		pattern: '/auth/logout',
		entrypoint: paket('dist/routes/auth/logout.js'),
		grund: 'Abmelden bei App und IdP.',
	},
	{
		pattern: '/api/lists/incoming',
		entrypoint: paket('dist/routes/api/lists/incoming.js'),
		grund:
			'Eingang für Listenmails aus dem Cloudflare-Email-Worker. Vertrag steht in email-worker/README.md.',
	},
	{
		pattern: '/api/lists/check',
		entrypoint: paket('dist/routes/api/lists/check.js'),
		grund: 'Vorabprüfung "darf dieser Absender an diese Liste senden?".',
	},
]
