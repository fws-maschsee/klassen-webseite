import { fileURLToPath } from 'node:url'

// Aus dem Modulpfad statt process.cwd(): in der Klasse liegt dieser Code unter geteilt/.
const wurzel = new URL('../../', import.meta.url)

export const geteilt = (relativ: string): string =>
	fileURLToPath(new URL(relativ, wurzel))

export type GeteilteRoute = {
	pattern: string
	entrypoint: string
	grund: string
}

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
		pattern: '/auth/backchannel-logout',
		entrypoint: geteilt('src/routes/auth/backchannelLogout.ts'),
		grund:
			'OIDC Back-Channel-Logout: ZITADEL meldet eine beendete Sitzung mit signiertem logout_token, die Sitzung hier endet sofort. Ohne Cookie, unter /auth/ und damit anmeldefrei.',
	},
	{
		pattern: '/auth/zitadel-events',
		entrypoint: geteilt('src/routes/auth/zitadelEvents.ts'),
		grund:
			'Webhook (ZITADEL Actions v2): gesperrte, geloeschte Konten und entzogene Grants beenden die Sitzungen sofort. HMAC-signiert (ZITADEL-Signature), ohne ZITADEL_WEBHOOK_SIGNING_KEY 404.',
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
		pattern: '/public/mitbringen/[id]',
		entrypoint: geteilt('astro/pages/public/mitbringen/[id].astro'),
		grund:
			'Mitbringliste („Wer bringt was zum Grillfest mit?"). Unter /public/, weil Eltern OHNE Konto eintragen sollen; der Schutz ist der nicht erratbare Schluessel im Pfad, angelegt ueber MCP. Wer angemeldet ist, bekommt seinen Namen vorausgefuellt.',
	},
	{
		pattern: '/public/mitbringen/[id]/stand',
		entrypoint: geteilt('src/routes/mitbringen/stand.ts'),
		grund:
			'Der Stand einer Mitbringliste als JSON mit Aenderungszaehler — die Seite fragt ihn alle paar Sekunden ab und zeichnet nur bei Aenderung neu.',
	},
	{
		pattern: '/public/mitbringen/[id]/eintrag',
		entrypoint: geteilt('src/routes/mitbringen/eintrag.ts'),
		grund:
			'Eintragen, aendern, loeschen auf einer Mitbringliste — ein POST fuer alle drei, damit die Seite auch ohne JavaScript funktioniert.',
	},
	{
		pattern: '/public/schichten/[id]',
		entrypoint: geteilt('astro/pages/public/schichten/[id].astro'),
		grund:
			'Schichtplan („Wer uebernimmt welche Schicht?"). Unter /public/, weil Eltern OHNE Konto eintragen sollen; der Schutz ist der nicht erratbare Schluessel im Pfad, angelegt ueber MCP.',
	},
	{
		pattern: '/public/schichten/[id]/stand',
		entrypoint: geteilt('src/routes/schichten/stand.ts'),
		grund:
			'Der Stand eines Schichtplans als JSON mit Aenderungszaehler — die Seite fragt ihn alle paar Sekunden ab und zeichnet nur bei Aenderung neu.',
	},
	{
		pattern: '/public/schichten/[id]/eintrag',
		entrypoint: geteilt('src/routes/schichten/eintrag.ts'),
		grund:
			'Schicht uebernehmen, aendern, abgeben — ein POST fuer alle drei, damit die Seite auch ohne JavaScript funktioniert.',
	},
	{
		pattern: '/public/health',
		entrypoint: geteilt('src/routes/health.ts'),
		grund:
			'Welcher Stand läuft? Nennt Commit des Klassen-Repos, Commit des geteilten Codes und die akzeptierten Signaturverfahren. Liegt bewusst unter /public/, weil dieser Pfad schon anmeldefrei ist — so bleibt PUBLIC_PATHS unverändert.',
	},
]
