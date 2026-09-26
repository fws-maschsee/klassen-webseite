import { familienEmpfaenger, naechsterPutztermin } from './putzplan.ts'
import type { PutzplanQuelle } from './putzplanErinnerung.ts'

export const putzplanQuelle = (): PutzplanQuelle => ({
	naechsterPutztermin,
	familienEmpfaenger,
})
