# Integrationstests der Anmeldung

Diese Tests starten ein echtes ZITADEL — dieselbe Fassung wie in Produktion —
und fahren die Anmeldung der Klassenseite einmal ganz durch: anstoßen, bei
ZITADEL anmelden, zurückspringen, Sitzung, geschützte Seite, Entzug.

## Warum es sie gibt

`src/server/auth/oidc.ts` (Anmeldung, Sitzung, Verlängerung) und
`src/server/auth/grants.ts` (Rollen aus der Management-API) sind die beiden
Dateien, an denen der Zugang hängt. Die Tests unter `tests/auth/` prüfen ihre
Regeln gegen Attrappen — also gegen Annahmen darüber, wie ZITADEL antwortet.
Diese Annahmen waren schon mehrfach falsch, und es steht in den Quellen
nachlesbar: `userIdQuery` liefert gegen diese Instanz zuverlässig null Zeilen,
`USER_GRANT_STATE_INACTIVE` endet auf „ACTIVE", ohne den Refresh-Grant-Typ gibt
es trotz `offline_access` kein Refresh-Token.

Dazu kommt der Anlass, aus dem der Auftrag entstand: **Diese Pfade werden selten
benutzt.** Ein Rechteentzug kommt in einer Klasse vielleicht einmal im Jahr vor.
Ein Weg, den niemand geht, ist der Weg, der kaputt ist, wenn man ihn braucht.
Bis hierher hat das nur die Produktion bewiesen, und zwar erst im Ernstfall.

## Starten

```bash
npm run test:integration
```

Mehr ist es nicht: `tests/integration/global-setup.ts` startet
`docker-compose.yml` mit `docker compose up --wait`, wartet auf die
Healthchecks, liest das Token des Maschinen-Benutzers und räumt am Ende ab.
Gebraucht wird Docker mit `compose` und ein freier Port 8080 (anders über
`ZITADEL_PORT`).

Zum Nachsehen nach einem Fehlschlag:

```bash
INTEGRATION_ZITADEL_KEEP=1 npm run test:integration
docker compose -f tests/integration/docker-compose.yml logs zitadel
docker compose -f tests/integration/docker-compose.yml down -v
```

Laufzeit auf einem gewöhnlichen Rechner: ZITADEL ist nach rund **zehn Sekunden**
bereit, der ganze Lauf dauert etwa **zwanzig Sekunden**. In CI liegt das
Zeitlimit bei zehn Minuten — als Reißleine, nicht als Budget.

## Was bewiesen wird

| | Nachweis | Fällt sonst auf durch |
|---|---|---|
| (a) | Geschützter Pfad ohne Sitzung liefert keinen Inhalt: eine Seite wird mit PKCE und `state` zu ZITADEL geschickt, alles andere bekommt 401. | Nichts. Eine Seite, die ohne Anmeldung ausliefert, sieht für den Angemeldeten genauso aus wie vorher. |
| (b) | Der vollständige OIDC-Ablauf trägt bis zur geschützten Seite: Code-Tausch, Signaturprüfung des ID-Tokens, `nonce`, Sitzungs-Cookie, Rückkehr auf den ursprünglichen Pfad. | Jede Anmeldung schlägt fehl — das fällt sofort auf, aber erst in Produktion. |
| (c) | Wer sich bei ZITADEL **erfolgreich** anmeldet, aber keinen Grant im Projekt dieser Klasse hat, kommt NICHT hinein. | Nichts. Das ist die Trennung „hat ein Konto" gegen „gehört zu dieser Klasse", und beide Fälle sehen bis zum Rücksprung identisch aus. |
| (d) | Wird der Grant WÄHREND einer bestehenden Sitzung entzogen, endet der Zugang, ohne dass die Person etwas tut. | Nichts, bis jemand nachsieht. In der abgelösten PocketBase-Gruppe hatten sechs Personen weiterhin Zugriff. |
| (e) | `/public/health` bleibt ohne Anmeldung erreichbar. | Kubernetes nimmt den Pod aus dem Service. Die Seite ist dann nicht langsam, sie ist weg. |

Zusätzlich prüft ein sechster Fall, dass der Einrichtungsschritt einen Benutzer
auch wieder **löschen** kann. Das ist kein Nachweis über die Anwendung, sondern
der Prüfstein für die Vorbereitung weiter unten.

## Was hier ECHT ist und was nicht

Echt: `startServer()` aus `src/server/app.ts` — derselbe Aufruf, den das
`server.ts` einer Klasse macht —, die Middleware aus `src/klasse/middleware.ts`,
`authenticate()`/`resolveSession()` aus `oidc.ts`, `rolesForUser()` aus
`grants.ts`, die drei Anmelderouten und `/public/health`. Angesprochen wird
alles über HTTP, mit Cookies, ohne Abkürzung im Prozess.

Attrappe ist genau zweierlei:

1. **Astros Routenauflösung und das Rendern der `.astro`-Seiten**
   (`astro-attrappe.ts`). Nicht aus Sparsamkeit: Dieses Repository ist gar keine
   Astro-App, sondern der geteilte Code, den die Klassen als Submodule
   einbinden. `astro.config.mjs` und `src/content/` liegen dort. Ein Build wäre
   also der Build einer Anwendung, die es hier nicht gibt. Was die Attrappe
   deshalb NICHT beweisen kann: dass eine `.astro`-Seite `Astro.locals.user`
   richtig benutzt.
2. **Die Anmeldemaske von ZITADEL.** Der Testcode benutzt die Session-API v2
   (`/v2/sessions`, `/v2/oidc/auth_requests/{id}`) — dieselben Schnittstellen,
   die die Login-Oberfläche v2 benutzt. Alles ab dem Rücksprung ist echt. Was
   das NICHT beweist: dass ZITADELs eigene Anmeldeseite erreichbar ist und ihre
   Formulare funktionieren.

## Wo das später andockt

Zwei Dinge sollen diese Umgebung später mitbeweisen. Sie sind hier
**vorbereitet, nicht gebaut** — im Code der Anwendung gibt es sie noch nicht.

### Webhook-Kaskade: ZITADEL löscht einen Benutzer

Gedacht ist: ZITADEL meldet die Löschung, die Anwendung räumt Konto und
Adressbucheintrag ab. Was schon da ist:

- `benutzerLoeschen()` in `zitadel.ts` löst den Vorgang aus, und der Test
  „Vorbereitung: der Einrichtungsschritt kann löschen" hält ihn lauffähig.
- ZITADELs **Actions v2** sind in v4.16.2 ab Werk eingeschaltet (nachgemessen:
  `POST /v2beta/actions/targets/search` antwortet ohne Feature-Schalter). Ein
  Ziel legt man mit `POST /v2beta/actions/targets` an, die Verknüpfung mit dem
  Ereignis mit `POST /v2beta/actions/executions`. Der Platz dafür ist
  `ausgangslageHerstellen()` — dort steht schon alles, was ein Ziel braucht
  (Organisation, Projekt, die Basis-URL der Anwendung).
- Das Ziel muss eine Adresse der **Anwendung** sein. Die Anwendung läuft im Test
  auf dem Host, ZITADEL im Container: Aus dem Container heißt der Host
  `host.docker.internal`, und `docker-compose.yml` braucht dafür einen
  `extra_hosts`-Eintrag. Das ist der einzige Punkt, an dem der Aufbau selbst
  angefasst werden muss.

Was NICHT hierher gehört: das Spiegeln von ZITADEL-Daten ins Adressbuch.
Adressbuch und ZITADEL sind getrennte Datenschichten, und
`tests/auth/getrennte-datenschichten.test.ts` hält das fest. Die Kaskade löscht,
sie legt nichts an.

### Prüfung beim Mailversand

Gedacht ist: Vor dem Versand an einen Verteiler wird geprüft, ob die Empfänger
noch Grants haben. Was fehlt, ist ein Postfach, in dem der Test die Mail
wiederfindet — dafür gehört ein Mailpit-Dienst (SMTP auf 1025, API auf 8025) in
`docker-compose.yml`, und `SES_SMTP_HOST`/`SES_SMTP_PORT` zeigen darauf (siehe
`src/lib/email/transport.ts`). Die Grant-Abfrage selbst braucht nichts Neues:
`rolesForUser()` läuft im Testprozess schon gegen dieses ZITADEL.

## Beim Heben der ZITADEL-Fassung

Der Tag in `docker-compose.yml` und der in `fws-maschsee/server-config`,
`argocd/applications/zitadel.yaml`, gehören zusammen. Laufen sie auseinander,
ist dieser Aufbau eine grüne Zusage über eine Software, die niemand betreibt.
Was beim Heben zuerst bricht, ist erfahrungsgemäß der Anmeldeweg: In v4 leitet
`/oauth/v2/authorize` auf die Login-Oberfläche v2 um, und die Kennung des
Vorgangs steht im Parameter `authRequest`. Sagt `beiZitadelAnmelden()` „Läuft
ZITADEL mit der Login-Oberfläche v1?", ist genau das passiert.
