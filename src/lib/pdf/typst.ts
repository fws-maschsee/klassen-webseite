import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const VORGABE_PROGRAMM = 'typst'

export const VORGABE_FRIST_MS = 10_000

export const DATEN_DATEI = 'daten.json'

const VORLAGEN_DATEI = 'dokument.typ'

export class TypstFehlt extends Error {
	constructor(programm: string) {
		super(
			`Das Typst-Programm "${programm}" ist nicht ausfuehrbar. Im Image kommt es aus einer eigenen Bau-Stufe (docker/typst-holen.sh); lokal setzt TYPST_BIN den Pfad.`,
		)
		this.name = 'TypstFehlt'
	}
}

export class TypstZeitueberschreitung extends Error {
	readonly fristMs: number

	constructor(fristMs: number) {
		super(`Der Satzlauf wurde nach ${fristMs} ms abgebrochen.`)
		this.name = 'TypstZeitueberschreitung'
		this.fristMs = fristMs
	}
}

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
	// Quelltext statt Pfad: Vite buendelt die Route nach dist/, ein modulrelativer Pfad zeigte daneben.
	vorlage: string
	daten: unknown
	fristMs?: number
	programm?: string
}

export const typstPdf = async (lauf: TypstLauf): Promise<Buffer> => {
	const programm =
		lauf.programm ?? process.env.TYPST_BIN?.trim() ?? VORGABE_PROGRAMM
	const fristMs = lauf.fristMs ?? VORGABE_FRIST_MS

	// Ein Verzeichnis je Lauf, sonst ueberschreiben sich gleichzeitige Laeufe die Daten.
	const arbeit = await mkdtemp(path.join(tmpdir(), 'typst-'))
	try {
		await writeFile(path.join(arbeit, VORLAGEN_DATEI), lauf.vorlage, 'utf8')
		// Daten als JSON-Datei, nie in den Quelltext eingesetzt: `#` in einem Namen waere sonst Typst-Code.
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
				// Das leere Arbeitsverzeichnis als Wurzel: die Vorlage kann keine Datei des Servers lesen.
				'--root',
				arbeit,
				// Sonst findet Typst je Basis-Image andere Systemschriften, und das PDF sieht still anders aus.
				'--ignore-system-fonts',
				// Paketpfade ins leere Verzeichnis: ein Import scheitert, statt zur Laufzeit aus dem Netz zu laden.
				'--package-path',
				arbeit,
				'--package-cache-path',
				arbeit,
				// Ein Kern je Lauf, damit ein Download nicht den ganzen Pod belegt.
				'--jobs',
				'1',
				'--diagnostic-format',
				'short',
				path.join(arbeit, VORLAGEN_DATEI),
				'-',
			],
			{
				cwd: arbeit,
				// Typst liest Schalter auch aus TYPST_*-Variablen; die Server-Umgebung koennte die Schalter oben still aushebeln.
				env: { PATH: process.env.PATH ?? '' },
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)

		const stuecke: Buffer[] = []
		const meldungen: string[] = []
		let beendet = false

		const wecker = setTimeout(() => {
			if (beendet) return
			beendet = true
			// SIGKILL: ein haengender Prozess reagiert auf ein behandelbares Signal gerade nicht.
			kind.kill('SIGKILL')
			ablehnen(new TypstZeitueberschreitung(fristMs))
		}, fristMs)
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
