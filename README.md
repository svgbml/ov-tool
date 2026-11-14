# OV-tool – storingen & vertragingen

Webapp (installeerbaar als app/PWA) die je vaste treintrajecten bewaakt via de NS-API:
actuele vertrektijden, vertraging, uitval, storingen/werkzaamheden en een **alternatief** (de eerstvolgende goede trein).

**Live:** https://svgbml.github.io/ov-tool/

## Functies
- **Trajecten** invoeren: van/naar-station, dagen, tijdvenster en meldingsdrempel (min vertraging).
  Standaard: Tilburg ⇄ Breda, ma–vr 07:30–19:00, melden vanaf 5 min.
- **Live**: per traject de volgende treinen binnen het venster; buiten het venster de eerste treinen van het volgende venster.
- **Storingen** op het traject (Disruptions API), overige meldingen rond de stations ingeklapt.
- **Browsermeldingen** bij vertraging ≥ drempel, uitval of storing (zolang de app open staat), inclusief alternatief.
- **Export/import** van trajecten als JSON.
- **Uiterlijk**: 5 thema's (Minimal (standaard), Spoor, Oceaan, Vertrekbord, Bloesem), elk in licht en donker, of automatisch volgens het systeem.
- Alles lokaal in de browser (localStorage); er is geen server.

## Installeren
1. Vraag een sleutel aan op [apiportal.ns.nl](https://apiportal.ns.nl/) → product **Ns-App** (bevat de Reisinformatie API) → kopieer de primary key.
2. Open de app → *Instellingen* → plak de sleutel → *Sleutel testen* → *Opslaan*.
3. Telefoon/pc: via het browsermenu "Installeren" / "Toevoegen aan beginscherm".

## Gebruikte endpoints
- `GET /reisinformatie-api/api/v3/trips` – reisadviezen (vertraging, uitval, alternatief)
- `GET /disruptions/v3/station/{code}` – storingen en werkzaamheden per station
- `GET /nsapp-stations/v3` – stationssuggesties

## Gepland
- Achtergrond-checker (GitHub Actions cron) met push via ntfy/Telegram, zodat meldingen ook komen als de app dicht is.
- Koppeling met Google Agenda: alleen checken op dagen met les/dienst.
- Bus/tram via OVapi.

Data: NS. Deze app is niet van of door NS.
