# @fws-maschsee/klassen-webseite

Der geteilte Code der Klassen-Webseiten der Freien Waldorfschule
Hannover-Maschsee: Astro-Integration, Anmeldung gegen ZITADEL, Mailinglisten,
MCP-Server und das Datenbankschema.

Eine Klassen-App bindet dieses Repository als **git submodule** unter
`geteilt/` ein und besteht danach aus ihren Inhalten, ihrer Konfiguration und
fünf Dreizeilern.

Kein npm-Package, kein `dist/`, kein Publish, keine Registry-Auth — die
Begründung steht in
[Submodule statt Package](#submodule-statt-package) und ist keine
Geschmacksfrage: `node --experimental-strip-types` verweigert
Type-Stripping in `node_modules` grundsätzlich
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

## Warum es das gibt

`klasse-wiesen` und `klasse-christophers` waren zwei Kopien derselben Anwendung.
Gemessen: 53 gemeinsame `.ts`-Dateien, davon 43 zeichengleich bis auf die
Einrückung. Von den zehn abweichenden enthielten acht eine Abweichung von zwei
bis fünf Zeilen — und in jedem dieser Fälle war es derselbe Klassenname an einer
anderen Stelle.

Das ist kein Schönheitsproblem. Es hat gekostet:

- Das Plugin, das Admonition-Titel sichtbar macht, gab es nur in einer Klasse.
  In der anderen blieben `:::warning[Titel]`-Überschriften einfach weg.
- Der Klassenkalender lag in einer Klasse unter einem Pfad, der eine Anmeldung
  verlangte. Eine Kalender-App meldet einen 404 niemandem — sie zeigt nur keine
  neuen Termine mehr. Sieben Monate lang aktualisierte kein einziges Abo, und
  aufgefallen ist es von Hand.
- Auf einer Verteiler-Seite stand monatelang eine abgelöste Mailman-Adresse,
  während die Anwendung längst anders zustellte.

Jeder dieser Fehler war in einer Klasse behoben und in der anderen nicht. Ein
Feature, das ein Schema ändert, war zweimal Handarbeit. Mit drei Klassen wäre es
dreimal.

## Was drin ist und was bewusst nicht

| im geteilten Code (`geteilt/`) | im Klassen-Repo |
| --- | --- |
| `src/lib/**` — Datenbank, Mailversand, Mailinglisten | `src/content/**` — Protokolle, Berichte, Unterlagen |
| `src/server/**` — Anmeldung, MCP-Server, OAuth-Provider, Express-App | `src/site.config.ts` — die `KlassenConfig` |
| die geteilten Routen (`/`, `/verteiler`, `/verwaltung`, `/logout`, `/oauth/consent`, `/auth/*`, `/api/lists/*`) | `public/**` — Kalender, PDFs, Bilder |
| `db/migrations/**` — das Datenbankschema | `deploy/**`, `Dockerfile`, `.env`, Sealed Secrets |
| `astro/content.config.ts` — das Schema der Inhalte, nicht die Inhalte | `email-worker/` — ein Worker je Klasse |
| die Astro-Integration mit dem ganzen Stack (Adapter, shipyard, Markdown-Plugins) | Playwright-/E2E-Tests, die eine laufende Instanz brauchen |
| `src/klasse/putzplan.ts` — Schema und Darstellung des Putzplans | `src/content/putzplan.yaml` — die Putz-Einteilung selbst |
| die Unit-Tests des geteilten Codes | |

**Die Inhalte bleiben in den Klassen-Repos, und zwar aus einem Grund, der sich
nicht wegorganisieren lässt: Rechte gelten bei GitHub pro Repository.** Wer
Zugriff auf dieses Repository hat, hätte Zugriff auf alles, was darin liegt. In
`src/content/blog/` liegen Elternabend-Protokolle mit Namen von Kindern und
Eltern, in `src/content/docs/` stehen private Mailadressen von
Ansprechpartnerinnen. Ein Elternteil der einen Klasse hat in den Unterlagen der
anderen nichts zu suchen, und ein künftiger Mitwirkender am geteilten Code hat
in keiner von beiden etwas zu suchen. Deshalb: ein Repository für den Code, ein
privates Repository je Klasse für ihre Inhalte. Das Submodule ändert daran
nichts — es verweist auf einen Commit, es kopiert keine Inhalte.

Aus demselben Grund beginnt die Historie dieses Repositorys frisch — siehe
[Entscheidungen](#entscheidungen).

## ZITADEL und das Adressbuch sind getrennte Datenschichten

Die Anwendung führt **zwei** Bestände über dieselben Menschen, und sie sprechen
nicht miteinander:

| | Wo | Was sie beantwortet | Wer sie pflegt |
| --- | --- | --- | --- |
| **Anmeldung** | ZITADEL, ein Projekt je Klasse | Wer ist das, und was darf er? (`authRole`, `admin`/`mitglied`, `canEdit`, `may_see_personal_data`, die Rollen im MCP-Token) | die Grants in ZITADEL |
| **Adressbuch** | Tabelle `mitglieder` in der SQLite-Datei der Klasse | Wer bekommt Post? | ein **Mensch**, über `/verwaltung` oder MCP |

**Es gibt keinen Übertrag von ZITADEL in das Adressbuch.** Nicht auf Knopfdruck,
nicht nebenbei, nicht beim Anmelden. Wer im Adressbuch steht, steht da, weil
jemand ihn eingetragen hat.

Vorher war es anders: eine Spiegelung (`src/server/auth/mirror.ts`) holte alle
Personen mit dem Rollen-Grant der Klasse und schrieb sie ins Adressbuch —
angestoßen durch das MCP-Werkzeug `sync_mitglieder` **und automatisch vor jeder
eingehenden Listenmail**. Beides ist entfernt, ebenso `usersWithRole()` in
`src/server/auth/grants.ts` und die Spalte `mitglieder.zitadel_user_id`, über
die die Spiegelung ihre Zeilen wiedererkannte. Wer den Namen `sync_mitglieder`
noch irgendwo findet — in einer Notiz, in einem Chatverlauf, in einem alten
Klassen-Stand —: das Werkzeug gibt es nicht mehr.

`src/server/auth/grants.ts` fragt weiterhin bei jedem Seitenaufruf und jedem
MCP-Werkzeugaufruf frisch bei ZITADEL nach — aber nur nach **Rollen**. Ein
entzogener Grant wirkt dort weiter sofort: der Zugang zur Seite und zum
MCP-Server ist weg.

### Die Folge, und sie ist datenschutzrelevant

Ein entzogener Grant nimmt **niemandem mehr die Post**. Das ist die Kehrseite
der Trennung, und sie geht in die unangenehme Richtung:

> **Wenn eine Familie die Klasse verlässt, bekommt sie weiter jede Elternmail —
> bis jemand ihren Adressbuch-Eintrag von Hand löscht.** Der Zugang zur Seite
> endet mit dem Grant, der Platz im Verteiler nicht. Es gibt keinen
> Automatismus, keine Erinnerung und keine Meldung.

Das heißt: **personenbezogene Daten stehen genau so lange im Verteiler, wie die
Klassenverwaltung sie stehen lässt.** Wer eine Klasse verwaltet, hat damit eine
Pflicht und nicht nur eine Möglichkeit — beim Schuljahreswechsel, bei einem
Schulwechsel, bei einem Todesfall. Die Werkzeuge dafür:

| Was | Wie |
| --- | --- |
| Person ganz aus dem Adressbuch entfernen | `delete_mitglied` über MCP, oder „löschen" in der Adressbuch-Tabelle unter `/verwaltung`. Gruppenzuordnungen, Opt-outs und Versandprotokoll gehen mit (FK CASCADE) |
| Person nur aus einem Verteiler nehmen, Eintrag behalten | `remove_from_group` (oder `bulk_remove_from_group` für mehrere) |
| Nachsehen, wen eine Liste erreicht | `list_list_recipients` — das ist die Liste, die wirklich Post bekommt |

Die zweite Hälfte der Folge ist die harmlose: Ein neues Elternteil bekommt
**keine** Post, bis es eingetragen ist — auch wenn es sich längst anmelden kann.
Das fällt auf, weil sich jemand beschwert, nichts bekommen zu haben.

Beides ist gewollt. Der Grund, es trotzdem so zu machen: Ein Automatismus, der
ungefragt Adressen anlegt und löscht, ist genau dann falsch, wenn er sich irrt —
und er irrt sich an den Rändern, an denen das Adressbuch mehr enthält als die
Elternschaft. Grosseltern, Lehrkräfte und externe Kontakte haben gar keinen
Zugang; für sie war jeder Abgleich blind. Die Trennung macht die Verantwortung
sichtbar, statt sie auf ein System zu schieben, das nur die halbe Wahrheit
kennt.

Bewacht wird die Trennung von
[`tests/auth/getrennte-datenschichten.test.ts`](tests/auth/getrennte-datenschichten.test.ts):
Er wird rot, sobald ein Modul wieder Grants bezieht **und** ins Adressbuch
schreibt, sobald der Weg einer Listenmail ZITADEL befragt, sobald das Adressbuch
eine Spalte mit Verweis auf ZITADEL bekommt und sobald der MCP-Server ein
Werkzeug anbietet, das einen Abgleich verspricht.

## Einbinden

### Das Submodule anlegen

```bash
git submodule add https://github.com/fws-maschsee/klassen-webseite.git geteilt
git commit -m "Geteilten Code als Submodule geteilt/ einbinden"
```

Ein Submodule zeigt auf **einen Commit**, nicht auf einen Branch. Genau das ist
die Eigenschaft, die vorher eine Versionsnummer hatte: eine Klasse zieht den
geteilten Code nachweislich absichtlich nach, und `git log geteilt` sagt, worauf
sie steht.

Klonen und aktualisieren brauchen deshalb je ein Wort mehr — ohne das ist
`geteilt/` ein leeres Verzeichnis, und der Build scheitert an fehlenden Dateien
statt an einer verständlichen Meldung:

```bash
git clone --recurse-submodules <klassen-repo>   # frisch
git submodule update --init --recursive         # in einem bestehenden Klon
```

Nachziehen auf den neuesten `main` des geteilten Codes:

```bash
git submodule update --remote geteilt
git add geteilt && git commit -m "Geteilten Code nachgezogen"
```

### Die Importe: `imports` in `package.json`

Node liest die `paths` einer `tsconfig.json` **nicht** — die kennt nur TypeScript.
Was Node nativ kennt, sind Subpath-Imports, und die stehen in der
`package.json` der Klasse:

```json
{
  "imports": {
    "#geteilt/*": "./geteilt/src/*",
    "#geteilt-astro/*": "./geteilt/astro/*"
  }
}
```

Damit heißt `@fws-maschsee/klassen-webseite/server/auth/roles` künftig
`#geteilt/server/auth/roles.ts`. Zwei Eigenschaften sind wichtig:

- **Die Endung `.ts` gehört in den Specifier.** Node löscht Typen, es schreibt
  keine Specifier um: die Datei heißt `roles.ts`, also muss im Import `roles.ts`
  stehen. `roles.js` gäbe es nirgends. Damit `tsc` bzw. `astro check` das
  akzeptiert, braucht die Klasse `"allowImportingTsExtensions": true`.
- **`#geteilt/*` zeigt in den Baum der Klasse, nicht in `node_modules`.** Das ist
  der ganze Punkt des Umbaus (siehe
  [Submodule statt Package](#submodule-statt-package)).

### Der Start: `node --experimental-strip-types`

```json
{
  "scripts": {
    "start": "node --experimental-strip-types server.ts"
  }
}
```

`tsx` braucht es dafür nicht mehr. Node ab 22.6 löscht die Typen selbst; ab
22.18 ist das nicht mehr hinter einem Flag, das Flag bleibt aber harmlos.

### Was dabei alles wegfällt

Es gibt **keine Registry mehr**, also auch nichts zu authentifizieren:

- keine `.npmrc` im Klassen-Repo,
- kein lokales PAT mit `read:packages`,
- kein `registry-url` / `scope` in `actions/setup-node`,
- kein `NODE_AUTH_TOKEN` und kein `permissions: packages: read` in den Workflows,
- kein BuildKit-Secret im `Dockerfile` und kein `secrets:` an
  `docker/build-push-action`.

`npm ci` läuft in einer Klasse jetzt **ohne jeden Token** durch — lokal, in der
CI und im Docker-Build. Beide Umzüge (`klasse-wiesen#91`,
`klasse-christophers#45`) waren an genau dieser Auth gescheitert, mit einem
`npm error code E401` aus einer Schicht, in der niemand ein Token vermutet.

Was die Workflows **stattdessen** brauchen, ist eine Zeile am Checkout — ohne sie
ist `geteilt/` leer:

```yaml
- uses: actions/checkout@v5
  with:
    submodules: recursive
```

Und im `Dockerfile` ist `geteilt/` ein gewöhnliches Verzeichnis im
Build-Kontext. Es muss in die Stages kopiert werden, die es brauchen, und
`.dockerignore` darf es nicht ausschließen. Die Runner-Stage braucht die
**Quellen** — es gibt kein `dist/` mehr:

```dockerfile
COPY --from=builder /app/geteilt ./geteilt
```

### Die fünf Dreizeiler

`astro.config.mjs`:

```js
import { fwsKlasse } from '#geteilt-astro/index.ts'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import appCss from './src/styles/app.css?url'
import { siteConfig } from './src/site.config'

export default defineConfig({
  // Das Vite-Plugin steht in der Klasse und nicht im geteilten Code:
  // `@tailwindcss/vite` muss in der Vite-Konfiguration DES PROJEKTS stehen,
  // damit es dessen CSS-Dateien sieht.
  vite: { plugins: [tailwindcss()] },
  integrations: [fwsKlasse({ config: siteConfig, css: appCss })],
})
```

`css` ist Pflicht, und `?url` ist keine Feinheit: shipyard braucht den **Pfad**
der Datei, nicht ihren Inhalt — es hängt sie über `virtual:shipyard/css` selbst
ein. Fehlt `css`, hat die Seite **kein einziges Stylesheet**, und weder
`astro build` noch `astro check` noch die Tests melden es. Deshalb führt der
geteilte Code das Feld als Pflichtfeld, obwohl shipyard es optional hat: so ist
es der einzige Fehler dieser Art, den `tsc` abfängt.

`src/middleware.ts`:

```ts
import { createKlassenMiddleware } from '#geteilt/klasse/middleware.ts'
import { siteConfig } from './site.config'

export const onRequest = createKlassenMiddleware(siteConfig)
```

`src/content.config.ts`:

```ts
export { collections } from '#geteilt-astro/content.config.ts'
```

`server.ts`:

```ts
import { startServer } from '#geteilt/server/app.ts'
import { siteConfig } from './src/site.config'

await startServer({ config: siteConfig })
```

Statischer Import, und `PUBLIC_BASE_URL` muss **nicht** gesetzt sein: kein Modul
des geteilten Codes liest die Konfiguration beim Import, und
`tests/server/importzeit.test.ts` hält das für **jedes** Modul unter `src/` fest.
Einmal war es anders — `mcp/handler.ts` baute seine Bearer-Middleware im
Modulkopf, und jeder Start ohne `PUBLIC_BASE_URL` starb mit „Keine KlassenConfig
hinterlegt". Das war nie eine Eigenschaft von npm, sondern die
Auswertungsreihenfolge von ESM-Importen: sie gilt per Submodule unverändert.

`src/styles/app.css` — der CSS-Einstieg, und die einzige Datei, deren Fehler kein
Build meldet: eine fehlende Zeile lässt `astro build` durchlaufen und die Seite
**völlig unformatiert** aussehen. Deshalb steht in der Klasse genau eine Zeile,
und der ganze Rest im geteilten Code:

```css
@import "../../geteilt/src/styles/klasse.css";
```

In `geteilt/src/styles/klasse.css` stecken `@import "tailwindcss"`, die drei
`@import "@levino/shipyard-*"` (die bringen shipyards Komponentenstile **und**
deren `@source`-Pfade mit), `@source "../../astro"` für die geteilten Seiten und
die beiden `@plugin`-Zeilen für `daisyui` und `@tailwindcss/typography`. Eine
Klasse, die etwas **ergänzen** muss, schreibt es unter den Import — die Vorgabe
kommt zuerst.

Eine `tailwind.config.mjs` gibt es nicht mehr: Tailwind 4 konfiguriert sich über
CSS, und daisyUI 5 lässt sich über eine JS-Config nicht mehr einstellen.

Bewacht wird der Vertrag von `tests/klasse/styling.test.ts`: der Test lässt
Tailwind über `klasse.css` laufen und prüft am erzeugten Stylesheet, dass es
plausibel groß ist, daisyUI-Komponenten enthält und Utilities, die **nur** in
`astro/pages/**` vorkommen. Ein grüner Build ist für diese Frage kein Beweis.

Und `src/env.d.ts`, damit `Astro.locals.user` und das virtuelle
Konfigurationsmodul typisiert sind. Über einen **Pfad**, nicht über `types=`:
`types=` sucht in `node_modules`, und dort liegt der geteilte Code nicht mehr.

```ts
/// <reference types="astro/client" />
/// <reference path="../geteilt/astro/env.d.ts" />
```

## Der Konfigurationsvertrag `KlassenConfig`

`defineKlassenConfig()` prüft und vervollständigt. Jede Prüfung ist gegen einen
Vorfall geschrieben, nicht gegen eine Möglichkeit.

### Pflicht

| Feld | Bedeutung |
| --- | --- |
| `slug` | Technischer Name, z. B. `klasse-wiesen`. Trägt **vier** Dinge, die zwingend zusammenpassen müssen: Name des ZITADEL-Projekts, Vorgabe für `MCP_INSTANCE_NAME`, Präfix der Listen-Domain und Dateiname der SQLite-Datei. Ein Wert statt vier, weil ein Auseinanderlaufen bedeutet, dass Post in der falschen Klasse landet. Nur `[a-z0-9-]` |
| `label` | Anzeigename, z. B. `Klasse Wiesen`. Seitentitel, Kopfzeile, Absendername |
| `domain` | Die Adresse, unter der die Instanz **jetzt** erreichbar ist, ohne Schema. Nicht vom `slug` abgeleitet, weil DNS und Zertifikat daran hängen und eine Klasse umziehen kann |
| `repoUrl` | GitHub-Repository der Klasse. Quelle für Edit- und Feedback-Links |
| `contactMail` | Adresse für Eltern, die angemeldet, aber noch nicht freigeschaltet sind |
| `calendarPath` | Pfad des Kalenders unter `public/`, z. B. `/public/poellmann.ics`; `null` für „keinen Kalender". Muss unter `/public/` oder `/api/lists/` liegen — sonst verlangt die Middleware eine Anmeldung, und die Abos brechen still ab. Genau dieser Fehler blieb sieben Monate unbemerkt, deshalb wird er hier abgelehnt statt dokumentiert |

#### `domain` ist die technische Adresse, nicht die historische

**In `domain` gehört der Host, den der Ingress heute ausliefert — nie der Name,
unter dem die Klasse einmal bekannt war.** Aus `domain` leitet der geteilte Code
`siteUrl` ab, aus `siteUrl` die `redirect_uri` der Anmeldung. Steht dort eine
abgelöste Adresse, die nur noch `301` liefert, dann schickt die App eine
`redirect_uri` an ZITADEL, die am OIDC-Client nicht hinterlegt ist: die Anmeldung
bricht mit einem Fehler von ZITADEL ab, und zwar für alle Eltern gleichzeitig.
Der Wert muss deshalb mit `OIDC_PUBLIC_ORIGIN` und `PUBLIC_BASE_URL` des
Deployments übereinstimmen.

Der alte Name lebt weiter, wo er ein **Schlüssel** ist und keine Adresse — in
`analyticsDomain`, weil Plausible Ereignisse für eine unbekannte Domain
kommentarlos verwirft, und in `calendarPath`, weil dieser Pfad in den
Kalender-Apps der Eltern steht. Für `klasse-wiesen` heißt das:

```ts
export const siteConfig = defineKlassenConfig({
  slug: 'klasse-wiesen',
  label: 'Klasse Wiesen',
  // Der Ingress-Host. NICHT klasse-poellmann.de — die alte Adresse liefert nur
  // noch 301, und die Anmeldung liefe gegen eine nicht hinterlegte redirect_uri.
  domain: 'klasse-wiesen.fws-maschsee-test.de',
  // Der alte Name, weil Plausible die Statistik daran hängt.
  analyticsDomain: 'klasse-poellmann.de',
  // Der alte Pfad, weil die Eltern genau ihn abonniert haben.
  calendarPath: '/public/poellmann.ics',
  repoUrl: 'https://github.com/fws-maschsee/klasse-wiesen',
  contactMail: '…',
})
```

### Optional, mit Vorgabe

| Feld | Vorgabe | Wann setzen |
| --- | --- | --- |
| `siteUrl` | `https://${domain}` | fast nie |
| `analyticsDomain` | `domain` | wenn die Seite umgezogen ist und ihre Plausible-Statistik behalten soll |
| `authRole` | `mitglied` | wenn das ZITADEL-Projekt die Leserolle anders nennt |
| `zitadelProject` | `slug` | wenn das Projekt anders heißt als die Klasse |
| `listBaseDomain` | `lists.fws-maschsee-test.de` | bei anderer Mail-Infrastruktur |
| `listDomain` | `${slug}.${listBaseDomain}` | bei einer Sonderroute im Email-Worker |
| `mailFrom` | `noreply@fws-maschsee-test.de` | nur mit einer anderen in SES verifizierten Adresse |
| `dbPath` | `./data/${slug}.db` | wenn das Volume anders eingehängt ist |
| `listPublicKeyPem` | der Ed25519-Schlüssel des Dispatchers (eingecheckt, **kein** Geheimnis) | nur mit einem eigenen Dispatcher — oder in Tests, die selbst ein Schlüsselpaar erzeugen |
| `listKeyIds` | `['bf2226d575ece8c8']` | zusammen mit `listPublicKeyPem`; die Id des Schlüssels muss enthalten sein, sonst lehnt `defineKlassenConfig` ab |
| `contactName` | keiner — die Texte nennen dann nur `contactMail` | wenn eine Person und nicht eine Funktionsadresse zuständig ist. Erscheint in der Ablehnungsmeldung („… kann sie vergeben") und auf der Verteiler-Seite |
| `calendarLegacyPath` | `null` | wenn der Kalender einmal unter einer anderen Adresse lag und dort noch Abos hängen. `startServer` leitet sie dauerhaft (301) auf `calendarPath` um, **vor** `express.static`. Nur die alte Adresse leitet um — der Pfad mit den echten Abos wird direkt ausgeliefert, weil Kalender-Clients Umleitungen nicht zuverlässig folgen (Apple: Fehler -1007) |
| `tagline` | `Unterlagen und Berichte` | nach Geschmack |
| `feedbackUrl` | `${repoUrl}/issues` | `klasse-christophers` zeigt auf `/discussions` |
| `farben` | keine | eigene daisyUI-Farben (`primary`, `secondary`, `accent`, `neutral`) |

Umgebungsvariablen schlagen die Konfiguration, wo es eine gibt
(`MCP_INSTANCE_NAME`, `DB_PATH`, `LIST_DOMAIN`, `PUBLIC_BASE_URL`,
`OIDC_REQUIRED_ROLE`, …). Grund: das Deployment sitzt näher an der Wirklichkeit
als das Repository — bei einem Umzug ist zuerst die Env richtig. Alle Variablen
mit Begründung: `.env.example`.

## Einstiegspunkte

Es gibt keine `exports`-Karte mehr, die Namen auf Dateien abbildet — der Pfad
**ist** der Name. Die Karte hier sagt, was früher welcher Subpfad war:

| Specifier | früher | Inhalt |
| --- | --- | --- |
| `#geteilt-astro/index.ts` | `.` | `fwsKlasse()` — die Integration. **Nur für `astro.config.mjs`** |
| `#geteilt/klasse/config.ts` | `./config` | `defineKlassenConfig`, `setKlassenConfig`, `klassenConfig`, `zustaendigkeit`, `PUBLIC_PATHS`, die Typen |
| `#geteilt/klasse/middleware.ts` | `./middleware` | `createKlassenMiddleware(config)` |
| `#geteilt-astro/content.config.ts` | `./content.config` | die Content-Collections |
| `#geteilt/server/app.ts` | `./server-app` | `startServer({ config })` |
| `#geteilt/migrations.ts` | `./migrations` | `packageMigrations()`, `packageMigrationsDir()`, `alleMigrations()`, `runMigrations()` |
| `#geteilt/klasse/kalender.ts` | `./kalender` | `pruefeKalender(projektWurzel, config)`, `webcalUrl(config)` |
| `#geteilt/klasse/putzplan.ts` | — | `putzplanSchema`, `optionaleDatei()`, `putzplanZeilen()`, `PUTZPLAN_DATEI` — neu, siehe [Strukturierte Daten](#strukturierte-daten-eine-yaml-datei-eine-sammlung-eine-erzeugte-seite) |
| `geteilt/src/styles/klasse.css` | `./styles/global.css` | der Tailwind-Einstieg; per `@import` aus `src/styles/app.css` der Klasse, nicht per Subpath-Import |
| `#geteilt/lib/…`, `#geteilt/server/…`, `#geteilt/remark/…` | `./lib/*`, … | der geteilte Code, einzeln |
| `#geteilt/klasse/…` | `./klasse/*` | Interna der Integration (`config`, `routes`, `locals`) |

**Alles ist Quelle.** Der Nodeteil (`src/lib/`, `src/server/`, `src/migrations.ts`)
lag früher als `tsc`-Ausgabe in `dist/`; das ist entfallen, weil Node die Typen
selbst löscht. Der Astro-Teil (`astro/`) war schon vorher Quelle und musste es
sein — `@levino/shipyard-*` liefert selbst rohes TypeScript aus, und vite-node
inlined nur, was Node nicht laden könnte. Als kompiliertes JavaScript würde die
Integration externalisiert, und Node scheiterte am `import` von shipyards
`.ts`-Datei.

`tsc` bleibt, aber nur noch als **Typprüfung** (`npm run typecheck`, `noEmit`).
Dazu steht `erasableSyntaxOnly: true` in `tsconfig.base.json` — der Wächter für
strip-types: `enum`, `namespace` mit Laufzeitinhalt, Parameter-Properties und
Decorators bräuchten erzeugten Code und scheiterten sonst erst beim Start einer
Klasse.

## Die Peer-Bereiche von `@levino/shipyard-*`

Sie sehen ungleich aus, und das ist gemessen und nicht vergessen:

| Paket | Version | Warum genau die |
| --- | --- | --- |
| `@levino/shipyard-base` | `0.7.5` | letzte **stabile** 0.7.x — von 0.7.6 gibt es nur Release-Candidates. Peers: `astro ^5.7`, `tailwindcss ^4`, `daisyui ^5`. 0.8.0 verlangt Astro 6 und ist damit eine eigene Etappe |
| `@levino/shipyard-blog` | `0.7.5` | hängt an `@levino/shipyard-base@^0.7.5` |
| `@levino/shipyard-docs` | `0.7.5` | hängt an `@levino/shipyard-base@^0.7.5` |

Alle drei auf **dieselbe** Version festgenagelt und nicht auf `^`: Ab wann welches
Paket welches `base` verlangt, war schon einmal die Ursache für zwei
`shipyard-base` in einem Baum.

Die Regel dahinter: ein Peer-Bereich darf nur so weit reichen, wie am Ende
**genau eine** `@levino/shipyard-base` im Baum steht. Nachzusehen mit
`npm ls @levino/shipyard-base` — mehr als eine Zeile ohne `deduped` ist der
Fehler, und er meldet sich nicht von selbst, sondern als Seite, die anders
aussieht.

Im Footer steht die **Anbieterkennzeichnung**, kein Copyright-Vermerk:
`Levin Keller, Hohenzollerndamm 152, 14199 Berlin`. Diese Seiten werden privat
betrieben und **nicht** von der Freien Waldorfschule Maschsee — auch wenn sie
nach Klassen benannt sind. Der Wert steht deshalb als Konstante `BETREIBER` in
`astro/integration.ts` und nicht in der `KlassenConfig`: Er ist für alle Klassen
derselbe, und eine Klasse, die ihn vergisst oder überschreibt, hätte eine Seite
ohne Anbieterangabe. Ohne den Wert schreibt shipyard nur `© <Jahr>` ohne Namen —
ein Fehler, der niemandem auffällt, weil die Seite normal aussieht. Deshalb
bewacht ihn `tests/klasse/betreiber.test.ts`. Die Zeile
„Built with Shipyard" daneben ist shipyards Vorgabe und bleibt stehen;
`hideBranding: true` würde sie entfernen.

## Ein neues Feature ausrollen

1. **PR gegen `main`.** Die CI prüft `typecheck`, `test`, `check`. Es gibt
   keinen `build`-Schritt mehr und keinen Tag, keine Version und kein Publish.
2. **In jeder Klasse ein Nachzieh-PR:**

   ```bash
   git submodule update --remote geteilt
   git add geteilt && git commit -m "Geteilten Code nachgezogen"
   ```

   Die CI der Klasse baut; danach mergen und deployen. Der Diff eines solchen
   PRs ist genau eine Zeile — der Commit-Hash im Submodule-Zeiger.

Eine neue geteilte Seite braucht dabei **keine Datei in einem Klassen-Repo**:
Datei unter `astro/pages/` anlegen, Eintrag in `src/klasse/routes.ts`,
nachziehen — und die Seite ist in allen Klassen da. Dasselbe für eine
Schema-Änderung: SQL-Datei unter `db/migrations/`, nachziehen; `startServer()`
wendet sie beim nächsten Start an.

Eine neue **Content-Collection** ist die Ausnahme davon — sie braucht eine Datei
im Klassen-Repo und damit zwei PRs in fester Reihenfolge, siehe
[Strukturierte Daten](#strukturierte-daten-eine-yaml-datei-eine-sammlung-eine-erzeugte-seite).

### Wenn der Nachzieh-PR mehr als eine Zeile ist

Tailwind 4 und daisyUI 5 sind so ein Fall: der Vertrag zwischen geteiltem Code
und Klasse hat sich geändert, also reicht der Submodule-Zeiger nicht. Was eine
Klasse dabei zu tun hat:

1. Submodule-Zeiger nachziehen.
2. `package.json`: `tailwindcss` → `^4.3.3`, `daisyui` → `^5.7.16`,
   `@tailwindcss/typography` → `^0.5.20`, `@tailwindcss/vite` `^4.3.3`
   **hinzu**, `@astrojs/tailwind` **entfernen**, alle drei
   `@levino/shipyard-*` → `0.7.5`. `astro` bleibt auf `^5`.
3. `package-lock.json` neu erzeugen (`rm package-lock.json && npm install`) —
   der alte Lock nagelt `shipyard-blog@0.6.1` fest und lässt `npm install` mit
   `ERESOLVE` stehen.
4. `tailwind.config.mjs` **löschen**. Tailwind 4 konfiguriert sich über CSS,
   daisyUI 5 lässt sich über eine JS-Config gar nicht mehr einstellen.
5. `src/styles/global.css` → `src/styles/app.css` mit der einen `@import`-Zeile
   auf `geteilt/src/styles/klasse.css`.
6. `astro.config.mjs`: `vite: { plugins: [tailwindcss()] }` und
   `css: appCss` (siehe [Die fünf Dreizeiler](#die-fünf-dreizeiler)).
7. In den **Inhalten** die umbenannten Klassen nachziehen: `shadow` →
   `shadow-sm`, `rounded` → `rounded-sm`, `blur` → `blur-sm` und die weiteren
   Skalenverschiebungen von Tailwind 4; `form-control`, `label-text`,
   `label-text-alt`, `*-bordered` sind in daisyUI 5 ohne Ersatz gestrichen.
8. `rm -rf dist .astro node_modules` vor dem ersten Build.
9. **Sichtprüfung, nicht nur grüner Build.** Ein fehlender CSS-Einstieg baut
   durch: `astro build`, dann im Client-Verzeichnis eine CSS-Datei > 100 KB
   suchen, die `admonition` und `btn` enthält.

### Strukturierte Daten: eine YAML-Datei, eine Sammlung, eine erzeugte Seite

**Regel: Was strukturierte Daten sind, kommt als Astro-Content-Collection aus
einer einzigen YAML-Datei im Klassen-Repo, und die Seite wird daraus erzeugt.
Keine zweite Quelle daneben — keine gepflegte Tabelle, keine Kopie im Markdown,
kein zweiter Ort mit denselben Angaben.**

Der Grund ist derselbe wie bei den Mailverteilern (siehe
`src/lib/lists/uebersicht.ts`): Dieselbe Angabe an zwei Orten heißt, dass eine
davon veraltet — und man erfährt nicht, welche. Auf der Verteiler-Seite stand so
monatelang eine abgelöste Mailman-Adresse, während die Anwendung längst anders
zustellte. Bei einer Putz-Einteilung wäre der Ausfall leiser und teurer: Ein
Tausch, der in einer der beiden Tabellen fehlt, bedeutet, dass eine Familie zu
ihrem Termin nicht erscheint. Die Seite sieht dabei vollständig aus.

Wo was liegt:

| | Datei | Repo |
| --- | --- | --- |
| die Daten | `src/content/putzplan.yaml` | **Klassen-Repo** |
| Schema, Loader, Darstellung | `src/klasse/putzplan.ts` | hier |
| die Sammlung | `astro/content.config.ts` | hier |
| die Seite | `astro/pages/docs/putzen/putzplan.astro` | hier |
| die Route | `src/klasse/routes.ts` | hier |

Die Aufteilung ist dieselbe wie bei `docs` und `blog` und hat denselben Grund:
Die Einteilung nennt die Familien einer bestimmten Klasse und gehört in kein
geteiltes Repository. Der Pfad in `optionaleDatei(...)` ist deshalb **relativ
zur Projektwurzel der Klasse**, genau wie bei
`createDocsCollection('./src/content/docs')`.

Der Putzplan als Beispiel, mit den drei Entscheidungen, die sich wiederholen
lassen:

- **`z.coerce.date()` statt `z.date()`.** YAML liefert `datum` je nach Parser
  als `Date` oder als String.
- **`id` steht nicht im Schema.** Der `file()`-Loader zieht sie aus dem Feld
  `id` jedes Eintrags. In der YAML gehört sie **in Anführungszeichen**
  (`id: "2026-08-21"`), weil ein nacktes `2026-08-21` als Datum geparst würde
  und der Loader einen String braucht.
- **Mengen als `.min(1)`, nicht als feste Zahl.** Zwei Familien pro Termin ist
  die Regel, aber keine Eigenschaft der Daten — bei ungerader Familienzahl
  bleibt der letzte Termin mit einer übrig.

**Eine Klasse ohne die Datei muss weiter bauen.** Astros `file()` schreibt für
eine fehlende Datei `File not found` als **Fehler** ins Build-Log — bei jedem
Build, ohne dass jemand etwas zu beheben hätte. Deshalb der Vorschalter
`optionaleDatei()` aus `src/klasse/putzplan.ts`: Fehlt die Datei, bleibt die
Sammlung leer und im Log steht eine Information. Die Seite antwortet dann so:

- **kein Docs-Eintrag `putzen/putzplan`** → `404`. Die Seite erscheint nicht.
- **Docs-Eintrag da, Sammlung leer** → nur die Prosa, keine Tabelle und kein
  Hinweis. `klasse-christophers` ist genau dieser Fall und trägt ihre Tabelle
  noch im Markdown; ein „hier fehlen Daten" stünde dort unter einer
  vollständigen Tabelle und wäre falsch. Der Hinweis richtet sich an die Person,
  die die Datei anlegt, und steht deshalb im Build-Log.

#### Eine neue Sammlung berührt immer zwei Repositories

Das ist der Unterschied zu einer neuen geteilten Seite, die ohne eine einzige
Datei im Klassen-Repo auskommt. Hier gibt es zwei PRs, und **die Reihenfolge ist
festgelegt:**

1. **Erst der geteilte Code** (dieses Repo): Schema, Sammlung, Seite, Route.
   Solange die Klasse die YAML-Datei nicht hat, ist die Sammlung leer und die
   Seite verhält sich wie vorher. Dieser PR ist allein mergefähig.
2. **Dann in der Klasse, in EINEM Commit:** die YAML-Datei anlegen, die alte
   Tabelle aus dem Markdown entfernen **und** den Submodule-Zeiger nachziehen.

Getrennt gemergt entsteht in genau einer Richtung ein Zwischenzustand, den keine
CI meldet: Wer die Tabelle aus dem Markdown nimmt, bevor der Submodule-Zeiger
steht, hat eine Elternseite mit Prosa und **ohne Einteilung** — `astro build`,
`npm test` und `npm run check` der Klasse laufen dabei grün durch, weil die
YAML-Datei unreferenziert unter `src/content/` liegt und Astro sie ignoriert.
Deshalb gehören Datei, Markdown-Änderung und Zeiger in einen Commit, und deshalb
darf der Klassen-PR nicht vor dem hiesigen gemergt werden.

## Was in einer weiterverteilten Listenmail steht

Eine Mail an `eltern@…` wird **nicht durchgereicht**, sondern je Empfänger neu
gebaut (`src/lib/lists/redistribute.ts`). So sieht das Ergebnis aus, wenn Vera
Beispiel an die Liste `Eltern` mit `reply_mode: list` schreibt:

```
From:             "Vera Beispiel (vera@example.org) via Eltern" <eltern@klasse-beispiel.lists.fws-maschsee.de>
To:               anna@example.org
Reply-To:         eltern@klasse-beispiel.lists.fws-maschsee.de
Sender:           noreply@fws-maschsee.de
Subject:          [Eltern] Elternabend am 3. September
List-Id:          Eltern <eltern.klasse-beispiel.lists.fws-maschsee.de>
List-Post:        <mailto:eltern@klasse-beispiel.lists.fws-maschsee.de>
List-Unsubscribe: <mailto:noreply@fws-maschsee.de?subject=Austragen%20eltern>
Precedence:       list
X-Original-From:  Vera Beispiel <vera@example.org>
```

Am Ende des Rumpfs steht ein Fuß, im Textteil so:

```
--------------------------------------------
Nur an Vera Beispiel (vera@example.org) antworten: mailto:vera@example.org?subject=Re%3A%20Elternabend%20am%203.%20September
„Antworten“ geht an alle Empfänger der Liste Eltern (eltern@klasse-beispiel.lists.fws-maschsee.de).
```

…und im HTML-Teil derselbe Inhalt als Absatz mit Trennlinie, eingefügt
unmittelbar vor `</body>` (fehlt das, wird angehängt):

```html
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #d4d4d4;…">
  <a href="mailto:vera@example.org?subject=Re%3A%20Elternabend%20am%203.%20September">Nur an Vera Beispiel (vera@example.org) antworten</a><br />
  „Antworten“ geht an alle Empfänger der Liste Eltern (eltern@…).
</div>
```

Warum jede Zeile so ist:

- **`From` zeigt auf die Liste, nicht auf die Privatadresse.** SES signiert nur
  für die eigene verifizierte Domain; eine fremde From-Domain scheitert an
  DMARC. Der Absender steht deshalb im Anzeigenamen.
- **Zwei Antwortwege, beide sichtbar.** „Antworten" folgt `Reply-To` und damit
  `reply_mode` (`list` → an alle, `sender` → an den Absender). Der Link im Fuß
  ist der zweite Weg: nur an die Person, die geschrieben hat. Der Fuß nennt
  beide, weil die Verwechslung nur in einer Richtung teuer ist — eine private
  Antwort an fünfzig Elternhäuser ist nicht zurückzuholen.
- **`List-Post` sagt, wer schreiben darf, nicht wohin Antworten gehen.** Die
  Listenadresse steht dort, wenn jeder Empfänger posten darf
  (`poster_policy: offen` oder `broadcast: true`), sonst `NO`. Mit `reply_mode`
  hat der Header nichts zu tun; die frühere Kopplung setzte `NO` auf offenen
  Listen, in die jeder schreiben durfte.
- **Signierte Nachrichten bekommen keinen Fuß.** Erkannt werden PGP/MIME und
  S/MIME an ihrem Signaturteil (`application/pgp-signature`,
  `application/pkcs7-signature`, `application/pkcs7-mime`) sowie inline
  signiertes PGP am Rumpf selbst. Jedes angehängte Zeichen würde die Signatur
  ungültig machen, und „Signatur fehlerhaft" beim Empfänger ist schlimmer als
  ein fehlender Hinweis.

### Hinweis: Die Absenderadresse ist für ALLE Empfänger sichtbar

Vorher war sie es nicht — sie stand allein in `X-Original-From`, und den zeigt
kein Mailprogramm an. Jetzt steht sie im Anzeigenamen **und** im `mailto:`-Link
des Fußes, also in jedem Programm und in jedem Weiterleitungs-Zitat.

Das ist eine bewusste Entscheidung und **nicht zurücknehmbar, sobald eine Mail
draußen ist**: In einer Klasse kennen sich die Eltern, und ohne sichtbare
Adresse gibt es keinen Weg zurück zum Absender — `From` und `Reply-To` zeigen
beide auf die Liste. Wer eine Liste braucht, auf der Absenderadressen verborgen
bleiben (eine Vertrauensadresse etwa), kann sie so nicht betreiben; das wäre
eine eigene Betriebsart und keine Einstellung an dieser Stelle.

### Hinweis: Der Rumpf wird nicht mehr unverändert durchgereicht

Bis hierher galt „Inhalt und Anhänge bleiben unverändert". Das ist **nicht mehr
richtig**: Der Fuß wird in Text- und HTML-Teil eingefügt. Unverändert bleiben
die **Anhänge** und der Rumpf **signierter** Nachrichten.

Der Fuß wird beim Versand gerechnet und nie gespeichert. Ein erneuter
Zustellversuch aus `list_outbound` baut damit zeichengleich dieselbe Mail. Und
zweimal steht der Fuß nie drin: trägt der Rumpf den `mailto:`-Link samt Betreff
schon, wird nichts angefügt.

## Nach dem 202 gibt es keinen Bounce mehr

Der Eingang quittiert dem Cloudflare-Worker mit **202**, sobald die Mail in
`list_messages`/`list_outbound` liegt — der Versand über SES kommt danach, aus
dem Queue-Worker. Das ist richtig so (eine SMTP-Sitzung darf nicht auf fünfzig
Zustellungen warten), hat aber eine Folge, die man kennen muss:

**Ab dem 202 kann keine Störung mehr beim Absender ankommen.** Vorher wird
abgelehnt, und der Worker macht daraus eine SMTP-Antwort; nachher ist die
SMTP-Sitzung beendet und niemand erzeugt eine Unzustellbarkeitsnachricht mehr.
Scheitert eine Zustellung, steht sie als `error` in `list_outbound` und sonst
nirgends. Aus Sicht der Eltern sieht das aus wie „die Mail ist einfach
verschwunden" — nicht angekommen, kein Bounce.

Damit dieser Zustand ablesbar und behebbar ist, gibt es dieselben zwei
Werkzeuge, die der Rundmail-Weg mit `get_send_log`/`retry_failed_sends` schon
hatte:

| Frage | Werkzeug |
| --- | --- |
| Ist meine Mail an den Verteiler überhaupt angekommen? | `list_list_messages` — steht sie nicht drin, hat die App sie nie angenommen; dann in die Logs des Cloudflare-Workers schauen |
| Was ist aus ihr geworden, Empfänger für Empfänger? | `get_list_message` — Status und Fehlermeldung je Zustellung |
| Gescheiterte Zustellungen nachreichen | `retry_failed_list_sends` — setzt genau die `error`-Zeilen auf `queued` zurück, erfolgreich Belieferte bleiben unangetastet |

`error` heißt „**unser** Sendeversuch ist gescheitert", nicht sicher „SES hat
nichts angenommen". Bricht die Verbindung nach der Annahme ab, erzeugt die
Wiederholung eine zweite Mail beim Empfänger. Eine doppelte Mail ist der
erträglichere Fehler gegenüber einer verlorenen — deshalb gibt es die
Wiederholung, und deshalb löst sie ein Mensch aus und kein Automatismus.

### Das Stunden-Cap ist ein gleitendes Fenster — und war es einmal nicht

Der Versand deckelt sich selbst: höchstens `MAIL_HOURLY_CAP` Zustellungen je
**gleitender** Stunde, geteilt zwischen Rundmails und Listenmails. Das ist eine
Reißleine gegen eine Schleife, die das SES-Kontingent der verifizierten Domain
verbrennt — keine Spam-Bremse für Eltern.

Gezählt wurde bis hierher `sent_at >= datetime('now','-1 hour')`, und das
vergleicht in SQLite zwei verschiedene Schreibweisen als **Text**:

```
gespeichert  2026-08-11T21:00:00.000Z   (strftime, mit T und Z)
verglichen   2026-08-11 20:30:00        (datetime, mit Leerzeichen)
```

An Stelle 10 steht `T` (0x54) gegen ` ` (0x20). `T` ist größer, also galt
**jede Zustellung des laufenden UTC-Tages** als „in der letzten Stunde". Aus dem
Stundenfenster wurde damit ein Tagesfenster, und es fiel erst, wenn die Grenze
über Mitternacht UTC rollte — um **01:00 UTC, in der Sommerzeit 03:00
Ortszeit**. Dort flossen die gestauten Mails ab, alle auf einmal.

Deshalb gibt es `dbTimestamp`/`dbTimestampBefore` in
[`src/lib/db/index.ts`](src/lib/db/index.ts): **ein** Format für alle
Zeitstempel dieser Datenbank, und jede Zeitgrenze wird in JS gerechnet und als
Parameter übergeben. Ein `datetime('now', …)` gegen eine mit `strftime`
geschriebene Spalte ist ab jetzt der Fehler, den man am Diff erkennt.
Festgehalten in [`tests/lists/stundencap.test.ts`](tests/lists/stundencap.test.ts),
inklusive des Falls „kurz nach Mitternacht".

Die Vorgabe steht bei **1000** je Stunde. 250 war zu eng gedacht: Eine Liste mit
59 Eltern ist EINE Mail = 59 Zustellungen, das Cap ließ also vier Elternmails
pro Stunde durch. Die echte Grenze ist das Sendekontingent des SES-Kontos — wer
es kennt, setzt `MAIL_HOURLY_CAP` und nimmt den Vorgabewert aus dem Spiel.

Anhänge haben an dieser Stelle keinen eigenen Weg: Sie liegen als BLOB in
`list_attachments`, werden je Empfänger unverändert an die Mail gehängt und sind
mit [`tests/lists/anhaenge.test.ts`](tests/lists/anhaenge.test.ts) vom Eingang
bis zum SMTP-Aufruf abgedeckt — byteweise. Was Anhänge ändern, ist die
Größenordnung: Eine Mail mit einem 218-kB-PDF an fünfzig Eltern sind rund 15 MB
ausgehend, und Störungen beim Provider trifft sie deshalb eher als eine
Textmail.

## Entwickeln

```bash
npm ci
npm run typecheck   # zwei Projekte: Nodeteil (NodeNext) und Astro-Teil, beide noEmit
npm test            # vitest
npm run check       # Biome
npm run lint:fix
```

Kein `npm run build`: es gibt nichts zu bauen. Damit ist `typecheck` die einzige
Stelle, an der ein Typfehler auffällt — vorher deckte der Build ihn mit ab.

Die Tests laufen gegen eine **erfundene** Klasse (`tests/setup.ts`). Das ist
Absicht: ein Test, der gegen `klasse-wiesen` grün ist, sagt nichts darüber, ob
derselbe Code in `klasse-christophers` läuft — und genau das ist die Frage, die
dieses Repository beantworten muss.

Ohne hinterlegte Konfiguration wirft `klassenConfig()`. Auch das ist Absicht:
eine erfundene Vorgabe wäre ein Klassenname, und ein falscher Klassenname
bedeutet Versand an die falsche Elternschaft.

## Entscheidungen

### Submodule statt Package

Der geteilte Code lag als `@fws-maschsee/klassen-webseite` in GitHub Packages.
Ausgelöst hat den Umbau ein Ziel, das damit unerreichbar war: `server.ts` einer
Klasse soll mit `node --experimental-strip-types` laufen statt mit `tsx`.

Der Grund ist eine harte Regel und keine Feineinstellung. Node **löscht** Typen,
es transformiert nicht — und in `node_modules` verweigert es das Löschen
grundsätzlich:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

Rohes TypeScript als Abhängigkeit ist damit ausgeschlossen. Rohes TypeScript im
**eigenen** Baum ist genau der vorgesehene Fall. Ein Package hätte also nur mit
`dist/` funktioniert — und `dist/` ist der Grund, warum es diese Regel überhaupt
zu umgehen gälte.

Was der Umbau nebenbei erledigt hat, ist der eigentliche Ertrag:

- **kein `dist/`, kein `exports`, kein `prepack`.** Der Pfad ist der Name.
- **kein Publish und kein Tag.** Zwei Versionen (0.2.2 und 0.2.3) waren wegen
  einer Störung der GitHub Actions nie veröffentlicht — getaggt, aber nicht
  installierbar. Ein Submodule-Zeiger kann diesen Zustand nicht haben.
- **keine Registry-Auth.** Kein lokales PAT, kein `NODE_AUTH_TOKEN` in der CI,
  kein BuildKit-Secret im Docker-Build. Das war nicht eine Konfiguration,
  sondern drei — an drei Orten, mit drei Fehlerbildern, und beide Umzugs-PRs
  sind daran gescheitert.
- **`npm ci` in einer Klasse läuft ohne jeden Token.**

Der Preis: ein Submodule ist unbequemer als eine Zeile in `package.json`. Wer
`--recurse-submodules` vergisst, bekommt ein leeres `geteilt/` und einen Build,
der über fehlende Dateien klagt statt über eine fehlende Abhängigkeit. Dafür
stehen die beiden Befehle im Abschnitt [Einbinden](#einbinden) und `submodules:
recursive` an jedem Checkout in den Workflows.

Und ein Vorteil, der vorher fehlte: eine Änderung am geteilten Code lässt sich in
einer Klasse **ausprobieren**, ohne sie zu veröffentlichen — `geteilt/` ist ein
normaler Checkout, in dem man einen Branch auschecken kann.

### Ein Repository für den Code statt eines Monorepos

Ein Monorepo wäre bequemer — ein Checkout, ein Lockfile, atomare Änderungen über
Code und Inhalte hinweg. Ein Submodule sieht wie der halbe Weg dorthin aus, ist
aber gerade nicht derselbe: es holt einen **fremden** Commit in den Baum, ohne
die Repository-Grenze aufzulösen. Und die muss bleiben, weil GitHub Rechte **pro
Repository** vergibt. Die Inhalte sind pro Klasse privat: Protokolle mit Namen
von Kindern, Mailadressen von Eltern. In einem Monorepo hätte jeder Zugriff auf
den Code auch Zugriff auf beide Klassen. Die Grenze zwischen „Code, den alle
teilen" und „Inhalte, die niemand teilen darf" ist genau die Grenze, die GitHub
durchsetzen kann — also verläuft sie zwischen Repositories. Ein Submodule
respektiert sie: der Zeiger geht in eine Richtung, und wer nur das geteilte Repo
lesen darf, sieht keine Klasse.

### `injectRoute` statt einer Seite pro Klasse

Die Alternative wäre gewesen, den geteilten Code nur als Bibliothek zu halten
und die
Seiten in jeder Klasse als dünne Wrapper anzulegen. Dann kostet eine neue Seite
n Pull Requests in n Klassen, und die n+1-te Klasse hat sie nicht. Genau so sind
die Unterschiede entstanden, die dieser geteilte Code auflöst — das
Admonition-Plugin in nur einer Klasse, die veraltete Verteiler-Adresse in nur
einer Klasse. Mit `injectRoute` gibt es die Datei einmal, und der einzige Weg, in
einer Klasse eine andere Fassung zu haben, ist ein anderer Submodule-Stand.

### Die Migrationen kommen mit

Sie sind kein Anhängsel. Der geteilte Code liest Spalten; existiert eine Spalte
in einer Klasse nicht, läuft er dort gegen ein Schema, das es nicht gibt. Blieben
die Migrationen in den Klassen, wäre jedes Feature mit Schema-Änderung wieder
Handarbeit pro Klasse — und ein vergessener Handgriff wäre ein Ausfall statt
eines Schönheitsfehlers. Die Reihenfolge ist deshalb festgelegt: erst alle
Migrationen des geteilten Codes, dann die klassen-eigenen. Klassen-Migrationen
dürfen auf dem geteilten Schema aufbauen, umgekehrt nie.

Gebucht wird in `schema_migrations` mit den Versionen, die auch dbmate schreibt.
Damit sind `dbmate up` im Container und `runMigrations()` beim Start
austauschbar, und eine bestehende Produktionsdatenbank wird nicht doppelt
migriert.

### Die Historie beginnt frisch

Kein `git subtree`, kein `git filter-repo` aus den Klassen-Repos. Deren Historie
enthält Elternabend-Protokolle, und Geschichte ist nicht löschbar, sondern nur
umschreibbar — jeder alte Commit-Hash bleibt bei GitHub abrufbar, und jeder Klon,
der schon existiert, hat alles. Der Preis ist, dass `git log` hier nicht
erzählt, warum eine Zeile so aussieht. Bezahlt wird er in den Kommentaren: die
Begründungen sind aus den Klassen-Repos mitgewandert und stehen bei dem Code,
den sie erklären.

### Zwei Signaturverfahren am Listeneingang

`POST /api/lists/incoming` nimmt **beides** an, und `X-List-Key-Id` entscheidet:
Header vorhanden → **Ed25519** (`fwslist.v2`, der neue zonenweite Dispatcher),
Header fehlt → **HMAC-SHA256** mit `LIST_WEBHOOK_SECRET` (die alten Worker je
Klasse). Die Fallunterscheidung steht in `src/lib/lists/incomingAuth.ts`.

Das ist kein Schalter, sondern ein Nebeneinander: Solange eine Listenadresse
eine literale Email-Routing-Regel hat, gewinnt sie gegen den Catch-all des
Dispatchers — umgestellt wird klassen- und listenweise, und beide Wege liefern
in derselben Woche ein.

Beide Pfade sind scharf, und keiner wird durch eine fehlende Konfiguration
übersprungen: ohne Secret scheitert der HMAC-Pfad, ohne Schlüssel der
Ed25519-Pfad, in beiden Fällen mit `401`. Ein `if (secret)`, das die Prüfung
auslässt, wenn nichts konfiguriert ist, wäre ein offenes Relais in die
Elternschaft.

Der öffentliche Schlüssel ist **eingecheckt** (`listPublicKeyPem`) und für alle
Klassen derselbe. Er ist kein Geheimnis: Damit lassen sich Aufrufe prüfen, aber
keine erzeugen — genau das ist der Grund für Ed25519. Vorher hielt jede App ein
HMAC-Secret, mit dem sich Post an die eigene Elternschaft fälschen ließ. Weil
jetzt alle Klassen mit demselben Schlüssel prüfen, sind die Metadaten (Klasse,
Liste, Empfänger, Envelope-Absender, Message-ID, Zeitstempel, Body-Hash)
mitsigniert: Ohne die Klasse in der signierten Zeichenkette ließe sich ein
gültiger Aufruf für Klasse A bei Klasse B einliefern.

Die kanonische Zeichenkette gibt es dadurch **zweimal** — hier und im
Dispatcher-Repo `lists-dispatcher`. Abgesichert ist das durch einen
Golden-String-Test auf jeder Seite; wer das Format ändert, ändert beide.

### Kein Abgleich zwischen ZITADEL und dem Adressbuch

Die Entscheidung und ihre betriebliche Folge stehen weiter oben, weil sie
niemand überlesen darf:
[ZITADEL und das Adressbuch sind getrennte Datenschichten](#zitadel-und-das-adressbuch-sind-getrennte-datenschichten).
Kurzfassung: Ein entzogener Grant sperrt den Zugang, nimmt aber niemandem die
Post — der Adressbuch-Eintrag muss von Hand gelöscht werden.

### Der Adapter steht in der Integration

`fwsKlasse()` liefert eine Liste von Integrationen und setzt den Node-Adapter
gleich mit. Das ist mehr, als eine Integration üblicherweise tut, spart aber der
Klasse eine `astro.config.mjs` mit einem Dutzend Zeilen, die in beiden Klassen
zeichengleich waren. Wer eine Klasse mit abweichendem Stack braucht, ruft die
Teile einzeln auf; der Weg dorthin ist ein Export mehr, keine Gabelung.
