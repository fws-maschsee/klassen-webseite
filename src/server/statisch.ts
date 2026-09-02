import fs from 'node:fs'
import path from 'node:path'
import type { RequestHandler } from 'express'
import {
	klassenConfig,
	PUBLIC_PATHS,
	wemGehoertDieSeite,
} from '../klasse/config.ts'
import { authenticate } from './auth/oidc.ts'

/**
 * Die Anmeldung vor `express.static`.
 *
 * ---------------------------------------------------------------------------
 * Der Fehler, gegen den diese Datei geschrieben ist
 * ---------------------------------------------------------------------------
 *
 * Astro spiegelt beim Bauen ALLES aus `public/` der Klasse nach `dist/client/`.
 * Express lieferte dieses Verzeichnis frueher ohne jede Pruefung aus, und zwar
 * VOR dem Astro-Handler — die Astro-Middleware, die die Anmeldung durchsetzt,
 * kam fuer solche Pfade nie an die Reihe.
 *
 * Damit war jede Datei unter `public/` fuer jeden abrufbar, der die Adresse
 * kannte. Nachgemessen an der laufenden Seite:
 *
 *     GET /                                  401
 *     GET /verteiler                         401
 *     GET /dokumente/stundenplan.pdf         200   <- ohne Anmeldung
 *     GET /dokumente/summary-kerzenziehen…   200   <- ohne Anmeldung
 *
 * Das war kein Sonderfall einer Klasse, sondern die Vorgabe fuer beide. Und es
 * war leise: Auf der Seite ist ein solches PDF nur hinter der Anmeldung
 * VERLINKT, es sieht also geschuetzt aus. Wer die Adresse einmal weitergibt —
 * per Mail, in einem Elternchat — gibt sie an alle weiter.
 *
 * ---------------------------------------------------------------------------
 * Die Regel
 * ---------------------------------------------------------------------------
 *
 * Statische Dateien sind keine Ausnahme von der Anmeldung. Frei bleibt genau
 * das, was `PUBLIC_PATHS` nennt (der Kalender unter `/public/`, der
 * Listen-Eingang) und der Anmeldevorgang selbst unter `/auth/`. Alles andere
 * beantwortet dieselbe Pruefung wie eine Seite: `authenticate()` — dieselbe
 * Funktion, die die Astro-Middleware ruft, nicht eine zweite, aehnliche.
 *
 * Geprueft wird NUR, was `express.static` auch wirklich ausliefern wuerde: Zu
 * jedem Pfad wird zuerst nachgesehen, ob unter dem Ausgabeverzeichnis eine
 * Datei liegt. Das ist keine Sparsamkeit, sondern eine Abgrenzung — fuer alles
 * andere ist die Astro-Middleware zustaendig, und zwei Instanzen, die
 * dieselbe Frage verschieden beantworten, sind schlimmer als eine. Ein erster
 * Anlauf pruefte pauschal jede Anfrage und lieferte dort, wo die
 * OIDC-Konfiguration fehlt (im Test, im Smoke-Lauf eines Images), ploetzlich
 * „Anmeldung nicht verfuegbar" statt der Seite, die Astro geliefert haette.
 *
 * Wenn die Pruefung selbst scheitert, geht die Datei NICHT heraus. Bei einer
 * Datei ist das die einzig vertretbare Richtung: Sie liesse sich nachher nicht
 * zurueckholen.
 *
 * Fuer den Menschen davor aendert sich nichts: Wer eine Seite anfragt, wird zum
 * Login umgeleitet; wer eine Datei anfragt (Kalender-App, PDF-Reader, curl),
 * bekommt 401 statt eines beschaedigt aussehenden Dokuments.
 */
export const nurAngemeldet = (staticDir: string): RequestHandler => {
	const wurzel = path.resolve(staticDir)

	return (req, res, next) => {
		// Denselben Schalter kennt die Astro-Middleware. Er ist fuer Tests da und
		// darf im Cluster nicht gesetzt sein.
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
		// Gebaute Stylesheets, Skripte und Schriften unter /_astro/ sind kein
		// Inhalt der Klasse, sondern das Aussehen der Seite — und die Seiten
		// unter /public/ (Abmelden, Adresse bestaetigen, Mitbringlisten) brauchen
		// sie OHNE Sitzung. Ohne diese Ausnahme kamen sie dort nackt an.
		// Bilder und Dokumente bleiben hinter der Anmeldung, auch unter /_astro/.
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
				// Erst hier gelesen und nicht beim Bauen der Middleware: Das
				// Register fuellt `startServer()`, und `app.ts` baut die Kette in
				// derselben Funktion zusammen. Ein Zugriff beim Bauen traefe je
				// nach Reihenfolge ein leeres Register.
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
				// Ein Fehler in der Pruefung darf NICHT bedeuten, dass die Datei
				// herausgeht. Er bedeutet: keine Auskunft.
				console.error('[statisch] Anmeldepruefung fehlgeschlagen:', fehler)
				res
					.status(503)
					.type('text/plain; charset=utf-8')
					.send('Anmeldung nicht verfügbar')
			}
		})()
	}
}

/**
 * Aus der Express-Anfrage eine `Request` bauen — mehr braucht `authenticate()`
 * nicht: die Adresse (fuer die Rueckkehr nach dem Login) und die Header (fuer
 * das Sitzungs-Cookie und `Accept`).
 *
 * Der Host kommt aus der Anfrage selbst und nicht aus der Konfiguration: Hinter
 * dem Reverse-Proxy steht er in `X-Forwarded-Host`, und Express loest das mit
 * `trust proxy` schon auf. Ein fester Host waere im Testlauf gegen 127.0.0.1
 * schlicht falsch.
 */
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

/** Eine `Response` in die Express-Antwort schreiben. */
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

/**
 * Liegt unter dem Ausgabeverzeichnis eine Datei zu diesem Pfad?
 *
 * Der aufgeloeste Pfad muss UNTERHALB der Wurzel bleiben. `express.static`
 * weist `..` selbst ab, aber diese Pruefung laeuft davor und mit einem eigenen
 * `path.join` — sie darf sich nicht darauf verlassen, dass jemand anderes
 * aufpasst. Ein Pfad, der hinausfuehrt, gilt als „keine Datei": Dann
 * entscheidet die Astro-Middleware, und `express.static` weist ihn ohnehin ab.
 *
 * `index.html` deckt den Fall ab, dass ein Verzeichnis angefragt wird —
 * genau das liefert `express.static` dort aus.
 */
const istDatei = (wurzel: string, pfad: string): boolean => {
	let entpackt: string
	try {
		entpackt = decodeURIComponent(pfad)
	} catch {
		// Kaputte Prozentkodierung: nichts, was ausgeliefert wuerde.
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
