import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * PDF erzeugen, indem ein Typst-Programm aufgerufen wird — mit allen Schaltern,
 * die aus einem Satzprogramm einen Dienst machen, den man von aussen aufrufen
 * darf.
 *
 * Warum ueberhaupt ein eigener Prozess und keine Bibliothek: Typst ist in Rust
 * geschrieben, es gibt keine gepflegte Node-Anbindung, und ein eigener Prozess
 * hat einen Vorteil, den eine Bibliothek nicht haben kann — er laesst sich
 * ABBRECHEN. Ein Satzlauf, der nicht fertig wird, kostet hier einen Kindprozess
 * und nicht den Server.
 *
 * Drei Zusicherungen macht dieses Modul, und jede ist gegen einen konkreten
 * Schaden geschrieben:
 *
 * 1. **Daten bleiben Daten.** Der Aufrufer gibt eine Vorlage (Typst-Quelltext)
 *    und einen Datenwert. Der Datenwert wird als JSON in eine Datei geschrieben,
 *    die die Vorlage mit `json("daten.json")` LIEST — er wird nicht in den
 *    Quelltext eingesetzt. Ein Familienname `Familie #strong[X]` ist damit ein
 *    Familienname und kein Typst-Befehl. Textersetzung in der Vorlage waere die
 *    naheliegende Loesung und zugleich eine Codeeinschleusung: `#` ist in Typst
 *    das Zeichen, mit dem Code anfaengt, und Familiennamen und Anmerkungen
 *    kommen aus der Datenbank, wo jeder Text stehen kann.
 *
 * 2. **Kein Zugriff nach draussen.** Der Lauf bekommt ein eigenes, leeres
 *    Verzeichnis als `--root`. Typst laesst aus einem Dokument heraus nur Pfade
 *    UNTERHALB dieser Wurzel zu; `#read("/etc/passwd")` und
 *    `#read("../../etc/passwd")` scheitern beide, statt eine Datei des Servers
 *    in ein PDF zu setzen, das jemand herunterlaedt. Ins NETZ geht Typst nur
 *    fuer Pakete aus dem Register (`#import "@preview/…"`); die Vorlagen hier
 *    importieren keines, und einschleusen laesst sich ein Import nach (1) nicht.
 *    Damit auch ein versehentlich eingebauter Import nicht zur Laufzeit etwas
 *    aus dem Internet nachlaedt, zeigen Paket- und Cache-Pfad ebenfalls in das
 *    leere Verzeichnis: Der Lauf scheitert dann mit einer Fehlermeldung, statt
 *    bei jedem Seitenaufruf einen fremden Server zu fragen.
 *
 * 3. **Er ist nach der Frist vorbei.** Ohne Frist wartet der Aufrufer so lange,
 *    wie das Programm braucht — und ein haengender Prozess belegt einen
 *    Node-Worker, bis jemand den Pod neu startet.
 *
 * Feldnamen und Werte, die zwischen Node und Typst laufen, sind englisch: das
 * ist eine Maschinenschnittstelle. Was ein Mensch im PDF liest, steht deutsch in
 * der Vorlage.
 */

/** Das Programm, wenn nichts anderes gesagt wird. */
const VORGABE_PROGRAMM = 'typst'

/** Wie lange ein Satzlauf hoechstens dauern darf. */
export const VORGABE_FRIST_MS = 10_000

/** Name der Datendatei im Arbeitsverzeichnis. Die Vorlage liest genau diesen. */
export const DATEN_DATEI = 'daten.json'

/** Name der Vorlagendatei im Arbeitsverzeichnis. */
const VORLAGEN_DATEI = 'dokument.typ'

/**
 * Das Programm ist nicht da.
 *
 * Eigener Fehlertyp, weil er etwas anderes bedeutet als ein Satzfehler: Nicht
 * die Daten sind kaputt, sondern das Image ist unvollstaendig. Der Aufrufer
 * kann daraus einen 503 machen — „hier fehlt etwas am Server" — statt einer
 * Meldung, die nach einem Fehler der Nutzerin klingt.
 */
export class TypstFehlt extends Error {
	constructor(programm: string) {
		super(
			`Das Typst-Programm "${programm}" ist nicht ausfuehrbar. Im Image kommt es aus einer eigenen Bau-Stufe (docker/typst-holen.sh); lokal setzt TYPST_BIN den Pfad.`,
		)
		this.name = 'TypstFehlt'
	}
}

/** Der Lauf hat die Frist gerissen und wurde abgebrochen. */
export class TypstZeitueberschreitung extends Error {
	readonly fristMs: number

	constructor(fristMs: number) {
		super(`Der Satzlauf wurde nach ${fristMs} ms abgebrochen.`)
		this.name = 'TypstZeitueberschreitung'
		this.fristMs = fristMs
	}
}

/** Das Programm lief, hat aber abgelehnt — Meldung steht dran. */
export class TypstFehler extends Error {
	readonly code: number | null
	readonly meldung: string

	constructor(code: number | null, meldung: string) {
		super(`Typst beendete sich mit ${code ?? 'Signal'}: ${meldung}`)
		this.name = 'TypstFehler'
		this.code = code
		this.meldung = meldung
	}
}

export type TypstLauf = {
	/**
	 * Der Quelltext der Vorlage. Ein STRING und kein Dateipfad: Die Route wird
	 * von Vite in `dist/` gebuendelt, ein Pfad relativ zum Modul zeigte danach
	 * neben die Datei. Ausserdem muss die Vorlage ohnehin in das Arbeits-
	 * verzeichnis des Laufs kopiert werden, damit `--root` sie umschliesst — ein
	 * Umweg ueber die Platte waere ein Lesen, dem ein Schreiben folgt.
	 */
	vorlage: string
	/** Was die Vorlage als `json("daten.json")` liest. Muss JSON-fähig sein. */
	daten: unknown
	/** Vorgabe: `VORGABE_FRIST_MS`. */
	fristMs?: number
	/** Vorgabe: `TYPST_BIN` aus der Umgebung, sonst `typst` aus dem PATH. */
	programm?: string
}

/**
 * Setzt die Vorlage mit den Daten und liefert das PDF.
 *
 * Das PDF kommt ueber die Standardausgabe (`-` als Ziel) und nicht ueber eine
 * Datei: Eine Datei muesste danach gelesen und aufgeraeumt werden, und der
 * Aufraeumschritt ist genau der, der im Fehlerfall ausgelassen wird.
 */
export const typstPdf = async (lauf: TypstLauf): Promise<Buffer> => {
	const programm =
		lauf.programm ?? process.env.TYPST_BIN?.trim() ?? VORGABE_PROGRAMM
	const fristMs = lauf.fristMs ?? VORGABE_FRIST_MS

	// Ein eigenes Verzeichnis JE LAUF. Zwei gleichzeitige Aufrufe duerfen sich
	// ihre Daten nicht gegenseitig ueberschreiben — bei einem Plan mit Namen
	// waere das Ergebnis nicht bloss falsch, sondern das PDF der anderen Klasse
	// auf demselben Server.
	const arbeit = await mkdtemp(path.join(tmpdir(), 'typst-'))
	try {
		await writeFile(path.join(arbeit, VORLAGEN_DATEI), lauf.vorlage, 'utf8')
		await writeFile(
			path.join(arbeit, DATEN_DATEI),
			JSON.stringify(lauf.daten),
			'utf8',
		)
		return await starte(programm, arbeit, fristMs)
	} finally {
		await rm(arbeit, { recursive: true, force: true })
	}
}

const starte = (
	programm: string,
	arbeit: string,
	fristMs: number,
): Promise<Buffer> =>
	new Promise<Buffer>((erfuellen, ablehnen) => {
		const kind = spawn(
			programm,
			[
				'compile',
				// Die Wurzel des Dokuments. Alles, was die Vorlage liest, muss
				// darunter liegen — hier also die zwei Dateien, die wir selbst
				// geschrieben haben.
				'--root',
				arbeit,
				// Nur die in Typst eingebauten Schriften. Das ist nicht Geschmack:
				// Ein Image ohne Systemschriften — und ein alpine-Image hat keine —
				// laesst Typst sonst bei jedem Lauf die Schriftverzeichnisse des
				// Systems absuchen und faende je nach Basis-Image andere Schriften.
				// Das PDF saehe dann davon abhaengig verschieden aus, ohne dass es
				// jemandem auffiele.
				'--ignore-system-fonts',
				// Pakete: siehe Kopfkommentar (2). Beide Pfade zeigen in das leere
				// Arbeitsverzeichnis, damit ein Import nicht ins Netz greift.
				'--package-path',
				arbeit,
				'--package-cache-path',
				arbeit,
				// Ein Kern je Lauf. Ein einzelner Download darf nicht alle Kerne des
				// Pods belegen, waehrend nebenher Seiten ausgeliefert werden.
				'--jobs',
				'1',
				// Kurze Diagnosen: Sie landen im Log des Servers, nicht auf der Seite.
				'--diagnostic-format',
				'short',
				path.join(arbeit, VORLAGEN_DATEI),
				'-',
			],
			{
				cwd: arbeit,
				// Eine aufgeraeumte Umgebung: Typst liest etliche seiner Schalter auch
				// aus Umgebungsvariablen (TYPST_ROOT, TYPST_FONT_PATHS,
				// TYPST_PACKAGE_PATH …). Waere die Umgebung des Servers dabei, koennte
				// eine dort gesetzte Variable die Schalter oben aushebeln — und zwar
				// still.
				env: { PATH: process.env.PATH ?? '' },
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)

		const stuecke: Buffer[] = []
		const meldungen: string[] = []
		let beendet = false

		// SIGKILL und nicht SIGTERM: Abgebrochen wird ein Lauf, der auf ein
		// Zeichen nicht mehr reagiert. Ein Signal, das der Prozess behandeln
		// duerfte, waere genau bei dem wirkungslos, den es treffen soll.
		const wecker = setTimeout(() => {
			if (beendet) return
			beendet = true
			kind.kill('SIGKILL')
			ablehnen(new TypstZeitueberschreitung(fristMs))
		}, fristMs)
		// Ein wartender Timer darf den Prozess nicht am Beenden hindern.
		wecker.unref?.()

		kind.stdout.on('data', (stueck: Buffer) => stuecke.push(stueck))
		kind.stderr.on('data', (stueck: Buffer) =>
			meldungen.push(stueck.toString('utf8')),
		)

		kind.on('error', (fehler: NodeJS.ErrnoException) => {
			if (beendet) return
			beendet = true
			clearTimeout(wecker)
			ablehnen(fehler.code === 'ENOENT' ? new TypstFehlt(programm) : fehler)
		})

		kind.on('close', (code) => {
			if (beendet) return
			beendet = true
			clearTimeout(wecker)
			if (code === 0) {
				erfuellen(Buffer.concat(stuecke))
				return
			}
			ablehnen(new TypstFehler(code, meldungen.join('').trim().slice(0, 2000)))
		})
	})
