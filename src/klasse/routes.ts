import { fileURLToPath } from 'node:url'

/**
 * Die geteilten Routen. Diese Liste ist der eigentliche Zweck des geteilten
 * Codes: eine neue Seite hier eintragen, in den Klassen das Submodule
 * nachziehen — und die Seite ist in allen Klassen da, ohne dass in einem
 * Klassen-Repo eine Datei entsteht.
 *
 * `/docs`, `/blog` und die Seitenleisten kommen weiterhin von den
 * shipyard-Integrationen; hier stehen nur die Routen, die diese Anwendung
 * selbst mitbringt.
 */

/**
 * Wurzel des geteilten Codes, aufgelöst aus dem eigenen Modulpfad. Bei der
 * Klasse ist das `geteilt/`, hier das Repo selbst; in beiden Fällen liegt
 * `src/klasse/` zwei Ebenen darunter.
 */
const wurzel = new URL('../../', import.meta.url)

const geteilt = (relativ: string): string =>
	fileURLToPath(new URL(relativ, wurzel))

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
 * Alle Einstiegspunkte zeigen auf QUELLEN. Vorher standen die `.ts`-Routen als
 * `dist/**.js` hier, weil sie beim Verbraucher aus `node_modules` kamen und
 * dort niemand sie kompiliert hätte. Das Submodule liegt im Baum der Klasse,
 * also übernimmt Vite das — wie bei den `.astro`-Dateien schon immer.
 */
export const GETEILTE_ROUTEN: readonly GeteilteRoute[] = [
	{
		pattern: '/',
		entrypoint: geteilt('astro/pages/index.astro'),
		grund:
			'Startseite: verweist nur auf /docs, /blog und /verteiler — alles Routen, die es in jeder Klasse gibt.',
	},
	{
		pattern: '/logout',
		entrypoint: geteilt('astro/pages/logout.astro'),
		grund: 'Abmelde-Bestätigung. Reines Formular gegen /auth/logout.',
	},
	{
		pattern: '/docs/putzen/putzplan',
		entrypoint: geteilt('astro/pages/docs/putzen/putzplan.astro'),
		grund:
			'Putzplan: Prosa aus der Unterlage, Tabelle aus der DATENBANK (`cleaning_dates`, gepflegt über MCP). Liegt auf dem BESTEHENDEN Docs-Pfad, weil Eltern ihn gespeichert haben; das statische Muster gewinnt gegen shipyards /docs/[...slug]. Eine Klasse ohne Termine in der Datenbank antwortet unverändert — die Seite kommt ohne Tabelle, eine Klasse ohne die Unterlage mit 404.',
	},
	{
		pattern: '/docs/putzen/putzplan.pdf',
		entrypoint: geteilt('src/routes/putzplanPdf.ts'),
		grund:
			'Derselbe Putzplan als PDF, bei jedem Aufruf aus der Datenbank gesetzt (Typst). Liegt NEBEN der Seite und damit hinter dem Login: im Plan stehen Familiennamen. Der Pfad ist vollstaendig statisch, sonst faengt shipyards /docs/[...slug] ihn ab und liefert HTML an einen PDF-Reader.',
	},
	{
		pattern: '/docs/stundenplan',
		entrypoint: geteilt('astro/pages/docs/stundenplan.astro'),
		grund:
			'Stundenplan: Prosa aus der Unterlage, Raster aus `src/content/stundenplan.yaml` der Klasse. Vollstaendig statisches Muster, damit es gegen shipyards /docs/[...slug] gewinnt. Eine Klasse ohne die Unterlage antwortet mit 404, eine ohne die YAML zeigt die Prosa allein.',
	},
	{
		pattern: '/docs/stundenplan.pdf',
		entrypoint: geteilt('astro/pages/docs/stundenplan.pdf.ts'),
		grund:
			'Derselbe Stundenplan als PDF (Typst), eine Seite je Gruppe, mit leeren Zeilen fuers Nachmittagsprogramm. Liegt NEBEN der Seite und damit hinter dem Login. Der Pfad ist vollstaendig statisch, sonst faengt shipyards /docs/[...slug] ihn ab und liefert HTML an einen PDF-Reader.',
	},
	{
		pattern: '/verteiler',
		entrypoint: geteilt('astro/pages/verteiler/index.astro'),
		grund:
			'Mailverteiler-Übersicht aus der Datenbank. Enthält keine Adresse und keine Domain fest verdrahtet.',
	},
	{
		pattern: '/verwaltung',
		entrypoint: geteilt('astro/pages/verwaltung/index.astro'),
		grund:
			'Verwaltung von Verteilern, Gruppen, Adressbuch und MCP-Zugängen. Der aufwendigste Teil und genau der, den niemand zweimal pflegen will.',
	},
	{
		pattern: '/oauth/consent',
		entrypoint: geteilt('astro/pages/oauth/consent.astro'),
		grund: 'Zustimmungsseite des OAuth-Flows für MCP-Clients.',
	},
	{
		pattern: '/auth/login',
		entrypoint: geteilt('src/routes/auth/login.ts'),
		grund: 'Anmeldung anstoßen; `?rd=/pfad` merkt sich das Ziel danach.',
	},
	{
		pattern: '/auth/callback',
		entrypoint: geteilt('src/routes/auth/callback.ts'),
		grund:
			'Rücksprung von ZITADEL. Muss eine echte Route sein: im middleware-Modus ruft Astro seine Middleware nur für Pfade auf, zu denen es eine Route gibt.',
	},
	{
		pattern: '/auth/logout',
		entrypoint: geteilt('src/routes/auth/logout.ts'),
		grund: 'Abmelden bei App und IdP.',
	},
	{
		pattern: '/api/lists/incoming',
		entrypoint: geteilt('src/routes/api/lists/incoming.ts'),
		grund:
			'Eingang für Listenmails aus dem zonenweiten Dispatcher (fws-maschsee/lists-dispatcher). Ed25519-signiert; der Vertrag steht dort in der README.',
	},
	{
		pattern: '/einstellungen',
		entrypoint: geteilt('astro/pages/einstellungen/index.astro'),
		grund:
			'Was jede Person von den Verteilern bekommt — Abo je Liste und Umgang mit der eigenen Post. HINTER dem Login: Die Adresse kommt aus der Anmeldung, nicht aus einem Link.',
	},
	{
		pattern: '/public/abmelden/[token]',
		entrypoint: geteilt('astro/pages/public/abmelden/[token].astro'),
		grund:
			'Abmelden ohne Anmeldung — die Gegenstelle zum List-Unsubscribe-Header. Die EINZIGE Sache, die ohne Konto geht: Wer raus will, soll dafür nicht erst eines anlegen. Der Schlüssel steht nur im Header, nie im Rumpf, wo ihn das erste Zitat an alle verteilen würde.',
	},
	{
		pattern: '/public/adresse-bestaetigen/[token]',
		entrypoint: geteilt('astro/pages/public/adresse-bestaetigen/[token].astro'),
		grund:
			'Bestätigung einer neuen Zustelladresse. Muss OHNE Anmeldung gehen: Der Klick passiert im Mailprogramm und damit oft in einem anderen Browser, in dem keine Sitzung liegt. Der Schlüssel im Link ist der Nachweis.',
	},
	{
		pattern: '/public/health',
		entrypoint: geteilt('src/routes/health.ts'),
		grund:
			'Welcher Stand läuft? Nennt Commit des Klassen-Repos, Commit des geteilten Codes und die akzeptierten Signaturverfahren. Liegt bewusst unter /public/, weil dieser Pfad schon anmeldefrei ist — so bleibt PUBLIC_PATHS unverändert.',
	},
]
