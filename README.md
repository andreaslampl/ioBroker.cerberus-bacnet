# ioBroker.cerberus-bacnet

Siemens **Cerberus PRO** Brandmeldezentralen (FC20xx, FC72x) über **BACnet/IP** in ioBroker:
Melder, Zonen, Ein- und Ausgänge mit Zustand, Alarm, Störung und Abschaltung, dazu
Sammelmeldungen für Brandalarm, Störung und Abschaltung. Optional (standardmäßig aus):
Rücksetzen, Akustik ab, Melder/Zonen ab- und einschalten, Ausgänge schalten.

Der Adapter tritt im Netz als eigenes BACnet-Gerät auf, mit der **Client-ID**, die in der
Zentrale als BACnet-Klient eingetragen ist (z. B. 10). Änderungen kommen sofort per
COV-Abonnement, zusätzlich fragt der Adapter regelmäßig ab (Absicherung und
Lebenszeichen für die Klienten-Überwachung der Zentrale).

## Voraussetzungen in der Zentrale (Cerberus-Engineering-Tool)

- *Globale BACnet-Konfiguration*: **BACnet-Kommunikation freigeben = Ja**
- *BACnet-Geräteobjekt*: **Device-Instanznummer** der Zentrale (z. B. 1)
- *BACnet client Konfiguration*: **BACnet Device ID** des Klienten (z. B. 10) und
  **Zugriffsrechte**: „Nur lesen“ reicht zum Anzeigen; für Befehle „Volle Bedienung/Befehle“

## Installation

```
iob url https://github.com/andreaslampl/ioBroker.cerberus-bacnet
```

Benötigt Node.js 20 oder neuer.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| IP-Adresse der Zentrale | z. B. `192.168.1.50` (optional `:Port`, Standard 47808) |
| BACnet-Geräte-ID der Zentrale | Device-Instanznummer, z. B. `1` |
| BACnet-Client-ID | wie in der Zentrale beim BACnet-Klienten eingetragen, z. B. `10` |
| Lokaler UDP-Port | Standard `47808`; der Port darf auf dem ioBroker-Server nicht von anderer BACnet-Software belegt sein |
| Abfrage alle | Standard 30 s |
| Befehle erlauben | **aus** = nur lesen; an = Rücksetzen, Akustik ab, Ab-/Einschalten, Ausgänge |

**Verschiedene Subnetze/VLANs:** Die Zentrale sucht ihren BACnet-Klienten per Broadcast; der
kommt nicht über Subnetz-Grenzen. Dann in der Zentrale *BACnet-Geräteobjekt → BBMD freigeben = Ja*
setzen und im Adapter **„Als Foreign Device bei der Zentrale anmelden (BBMD)“** einschalten.

**Firewall / VLAN:** zwischen ioBroker-Server und Zentrale **UDP 47808 in beide Richtungen**
freigeben (die Zentrale schickt Änderungen von sich aus). BACnet-Broadcasts gehen nicht über
VLAN-Grenzen, deshalb wird die IP der Zentrale fest eingetragen.

## Datenpunkte

### Sammelmeldungen `summary`

| Datenpunkt | Bedeutung |
| --- | --- |
| `summary.alarm` / `alarmList` | Brandalarm aktiv / welche Melder bzw. Zonen |
| `summary.preAlarm` | Voralarm |
| `summary.fault` / `faultList` | Störung aktiv / welche |
| `summary.disabled` / `disabledList` | Abschaltung aktiv / was |
| `summary.lastChange` | letzte Änderung als Text, z. B. `Brand Küche: Alarm` |
| `summary.lastMessage` | letzte Ereignismeldung der Zentrale (falls gesendet) |

### Pro Objekt `objects.<typ>_<nummer>`

Typen: `point` (Melder/Punkt), `zone` (Zone/Bereich), `bi`/`bo`/`bv` (binär), `msi`/`mso`/`msv`
(mehrstufig), `ai`/`ao`/`av` (analog). Der Name kommt aus der Zentrale (Kundentext).

| Datenpunkt | Bedeutung |
| --- | --- |
| `name` | Name/Kundentext |
| `state` | Zustand als Text (Ruhe, Alarm, Störung, …) |
| `value` | Rohwert; bei Ausgängen mit „Befehle erlauben“ schaltbar (leer = Befehl zurücknehmen) |
| `alarm`, `preAlarm`, `fault`, `disabled` | Einzelzustände |
| `mode` | Betriebsart (z. B. Ein/Aus = eingeschaltet/abgeschaltet); mit „Befehle erlauben“ schreibbar |
| `reset`, `silence` | Knöpfe (nur mit „Befehle erlauben“) |

### Befehle an die ganze Zentrale `panel`

`panel.reset` (Rücksetzen), `panel.silence` (Akustik ab), `panel.unsilence` (Akustik wieder ein) –
nur mit „Befehle erlauben“.

`info.objectTypes` zeigt, welche BACnet-Objekttypen die Zentrale wie oft meldet (hilfreich bei
der Fehlersuche).

## Hinweis

Befehle verändern den Zustand einer Brandmeldeanlage. Nur einschalten, wenn du die Anlage
bedienen darfst. Der Adapter ersetzt keine Feuerwehr-Bedienung und keine zugelassene
Alarmübertragung.

## Entwicklung

```
npm install
npm test
```

Die Tests laufen gegen eine simulierte Zentrale (`test/fake-panel.js`, BACnet über 127.0.0.1).

## Lizenz

MIT. Verwendet [@bacnet-js/client](https://github.com/bacnet-js/client) (MIT).
