export const ZEITZONE = 'Europe/Berlin'

const TEILE = new Intl.DateTimeFormat('en-US', {
	timeZone: ZEITZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
})

export type BerlinTeile = {
	jahr: number
	monat: number
	tag: number
	stunde: number
	minute: number
	sekunde: number
}

export const berlinTeile = (zeitpunkt: Date): BerlinTeile => {
	const teile = Object.fromEntries(
		TEILE.formatToParts(zeitpunkt).map(({ type, value }) => [type, value]),
	)
	const zahl = (name: string): number => Number.parseInt(teile[name] ?? '0', 10)
	return {
		jahr: zahl('year'),
		monat: zahl('month'),
		tag: zahl('day'),
		stunde: zahl('hour'),
		minute: zahl('minute'),
		sekunde: zahl('second'),
	}
}

const versatzMs = (zeitpunkt: Date): number => {
	const t = berlinTeile(zeitpunkt)
	const volleSekunden = Math.floor(zeitpunkt.getTime() / 1000) * 1000
	return (
		Date.UTC(t.jahr, t.monat - 1, t.tag, t.stunde, t.minute, t.sekunde) -
		volleSekunden
	)
}

export const berlinZeitpunkt = (
	jahr: number,
	monat: number,
	tag: number,
	stunde = 0,
	minute = 0,
): Date => {
	const alsWaereEsUtc = Date.UTC(jahr, monat - 1, tag, stunde, minute)
	const ersterVersuch = alsWaereEsUtc - versatzMs(new Date(alsWaereEsUtc))
	return new Date(alsWaereEsUtc - versatzMs(new Date(ersterVersuch)))
}
