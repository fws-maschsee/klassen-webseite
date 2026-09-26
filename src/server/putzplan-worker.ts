import type { Database } from 'better-sqlite3'
import type { PutzplanQuelle } from '../klasse/putzplanErinnerung.ts'
import { sendeFaelligeErinnerung } from '../klasse/putzplanErinnerung.ts'
import { putzplanQuelle } from '../klasse/putzplanQuelle.ts'
import type { EmailTransport } from '../lib/email/transport.ts'

const DEFAULT_POLL_MS = 10 * 60_000

export type ErinnerungsdienstOptionen = {
	intervalMs?: number
	quelle?: PutzplanQuelle
	db?: Database
	transport?: EmailTransport
}

let timer: NodeJS.Timeout | null = null
let running = false

const log = (nachricht: string): void => {
	console.log(`[putzplan-worker] ${nachricht}`)
}

const tick = async (
	optionen: ErinnerungsdienstOptionen & {
		quelle: PutzplanQuelle
	},
): Promise<void> => {
	if (running) return
	running = true
	try {
		const ergebnis = await sendeFaelligeErinnerung({
			quelle: optionen.quelle,
			db: optionen.db,
			transport: optionen.transport,
		})
		if (ergebnis.kind === 'sent') {
			log(
				`${ergebnis.terminDate}: an ${ergebnis.recipients} Adresse(n) verschickt` +
					(ergebnis.unreached.length > 0
						? `, NICHT erreicht: ${ergebnis.unreached.join(', ')} (gemeldet)`
						: ''),
			)
		} else if (ergebnis.kind === 'retry_later') {
			log(
				`${ergebnis.terminDate}: ${ergebnis.error} — neuer Versuch beim naechsten Nachsehen`,
			)
		}
	} catch (fehler) {
		log(
			`Nachsehen fehlgeschlagen: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
		)
	} finally {
		running = false
	}
}

export const startErinnerungsdienst = (
	optionen: ErinnerungsdienstOptionen = {},
): void => {
	if (timer) return

	let quelle: PutzplanQuelle
	try {
		quelle = optionen.quelle ?? putzplanQuelle()
	} catch (fehler) {
		log(
			`NICHT gestartet: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
		)
		return
	}

	const intervalMs = optionen.intervalMs ?? DEFAULT_POLL_MS
	log(`Start (Nachsehen alle ${Math.round(intervalMs / 60_000)} Minuten)`)
	void tick({ ...optionen, quelle })
	timer = setInterval(() => {
		void tick({ ...optionen, quelle })
	}, intervalMs)
}

export const stopErinnerungsdienst = (): void => {
	if (timer) {
		clearInterval(timer)
		timer = null
	}
}
