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

### Der Adapter steht in der Integration

`fwsKlasse()` liefert eine Liste von Integrationen und setzt den Node-Adapter
gleich mit. Das ist mehr, als eine Integration üblicherweise tut, spart aber der
Klasse eine `astro.config.mjs` mit einem Dutzend Zeilen, die in beiden Klassen
zeichengleich waren. Wer eine Klasse mit abweichendem Stack braucht, ruft die
Teile einzeln auf; der Weg dorthin ist ein Export mehr, keine Gabelung.
