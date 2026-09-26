import { familienEmpfaenger, naechsterPutztermin } from './putzplan.ts'
import type { PutzplanQuelle } from './putzplanErinnerung.ts'

// Reicht nur weiter, bleibt aber als Naht: ändert sich der Vertrag, ändert sich diese Datei statt des Versandcodes.
export const putzplanQuelle = (): PutzplanQuelle => ({
	naechsterPutztermin,
	familienEmpfaenger,
})
