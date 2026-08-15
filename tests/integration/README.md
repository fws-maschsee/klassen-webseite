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

## Konten-Prüfung vor dem Versand (`kontopruefung.test.ts`)

Die zweite Datei in diesem Verzeichnis. Sie beweist „ohne Konto, keine E-Mail"
(siehe README des Repositorys) gegen dasselbe echte ZITADEL:

| | Nachweis | Fällt sonst auf durch |
|---|---|---|
| (1) | Konto vorhanden und Rolle da → die Mail geht raus, samt der Sammeladresse ohne Adressbuch-Eintrag. | Nichts, bis eine Klasse auf `enforce` steht und plötzlich niemand mehr Post bekommt. |
| (2) | Rolle entzogen, `enforce` → die Adresse wird geschnitten UND gemeldet, mit dem Grund `role_missing`. | Nichts. Eine leere Empfängerliste sieht im Protokoll aus wie eine erledigte Zustellung. |
| (3) | Rolle entzogen, `report` → es wird zugestellt und trotzdem gemeldet. | Die Vorgabe-Betriebsart wäre ungeprüft — also genau die, die überall läuft. |
| (4) | ZITADEL nicht erreichbar, `enforce` → kein Versand, Ergebnis `unavailable` (HTTP 503). In `report` wird verteilt, die Prüfung ist blind. | Eine Störung bei ZITADEL verteilte an alle — oder hielte umgekehrt jede Elternmail auf. |

Warum das ein echtes ZITADEL braucht: Die Prüfung baut auf zwei Annahmen auf,
die eine Attrappe nur bestätigen kann. Dass die Grant-Antwort die
**Anmeldeadresse** mitliefert — daran hängt die Verbindung zum Adressbuch,
solange `mitglieder.user_sub` bei fast allen leer ist. Und dass ein Konto nach
dem Entzug seines Grants aus der Projekt-Abfrage verschwindet, ohne aus der
Benutzerliste zu verschwinden — daran hängt die Unterscheidung „Grant entzogen"
gegen „Konto gelöscht".

Attrappe ist hier einzig der SMTP-Transport: Er sammelt, was SES bekommen hätte.
Ein Mailpit daneben (siehe unten, früherer Plan) würde denselben Satz beweisen
und dafür einen zweiten Container brauchen — die Prüfung sitzt **vor** der
Warteschlange, und was sie entscheidet, steht in `list_outbound`, lange bevor
ein Postfach davon erfährt.

## Wo das später andockt

Eines soll diese Umgebung später mitbeweisen. Es ist hier **vorbereitet, nicht
gebaut** — im Code der Anwendung gibt es das noch nicht.

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

### Erledigt: Prüfung beim Mailversand

Hier stand der Plan, dafür einen **Mailpit** aufzunehmen (SMTP auf 1025, API auf
8025), damit ein Test die verschickte Mail in einem Postfach wiederfindet. Die
Prüfung ist gebaut (`kontopruefung.test.ts`, oben), und der Mailpit ist es
nicht — bewusst: Die Prüfung entscheidet **vor** der Warteschlange, ihr Ergebnis
steht in `list_outbound` und im Bericht, und ein Postfach fügt dem nichts hinzu
außer einem Container und zehn Sekunden je Pull Request. Wer später etwas
prüfen will, das wirklich erst im Postfach sichtbar wird — Kopfzeilen, Kodierung,
Anhänge —, findet den Plan hier.

## Beim Heben der ZITADEL-Fassung

Der Tag in `docker-compose.yml` und der in `fws-maschsee/server-config`,
`argocd/applications/zitadel.yaml`, gehören zusammen. Laufen sie auseinander,
ist dieser Aufbau eine grüne Zusage über eine Software, die niemand betreibt.
Was beim Heben zuerst bricht, ist erfahrungsgemäß der Anmeldeweg: In v4 leitet
`/oauth/v2/authorize` auf die Login-Oberfläche v2 um, und die Kennung des
Vorgangs steht im Parameter `authRequest`. Sagt `beiZitadelAnmelden()` „Läuft
ZITADEL mit der Login-Oberfläche v1?", ist genau das passiert.
