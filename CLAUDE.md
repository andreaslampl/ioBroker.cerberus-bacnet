# ioBroker.fc20-cerberus-bacnet

ioBroker adapter for Siemens Cerberus PRO fire panels over BACnet/IP. Owner's panel: FC2040
(FW 80.x), device instance 1; BACnet client configured in the panel with device ID 10 and
"Volle Bedienung/Befehle"; "Max. Klienten-Abfrageintervall" 10; COV max 500; DCC off.

## Layout

- `main.js` – adapter: objects/states per BACnet object, summary states, commands (only with
  `allowControl`, default off - keep it that way), all state writes serialized via `_queue`.
- `lib/link.js` – `BacnetLink` on `@bacnet-js/client` (pinned 3.3.2, Node >= 20): our own device
  (answers Who-Is/ReadProperty/RPM for device <clientId>), ACKs confirmed COV/event notifications,
  client services, `lifeSafetyOperation` encoded by hand (the library has no client method; uses
  its internal npdu/apdu/services modules).
- `lib/panel.js` – `Panel`: object list (full read, else by array index), properties via RPM in
  batches of 4 (fallback single reads when the panel rejects RPM with Class:5), COV subscriptions
  (renewed before lifetime ends), polling as safety net/keep-alive (device DATABASE_REVISION each
  poll -> full re-read on change; without it the object-list length every 20th poll; poll/refresh
  results are dropped for objects that got a COV meanwhile), commands: MODE write,
  LifeSafetyOperation (device = whole panel), PRESENT_VALUE write with priority (null = relinquish).
- `lib/naming.js` – `arrange()`: folder + readable name + state ID per object from the Cerberus object
  name pattern `L[PZ]_<KIND>_<address>_<panel>/<element>` (rules table, first match wins); sounder
  bases get their detector's name (same address minus last segment); duplicates get the address;
  loop-device channels -> hardware; `intern` hidden unless `showAll`. States: `objects.<folder>.<slug>`.
- `lib/texts.js` – German texts for life safety state/mode, which states count as alarm/fault/off.
- `test/` – `node --test` against `test/fake-panel.js` (library as device on 127.0.0.1).

## Status

- Built from the owner's site export (Cerberus engineering tool XML, contains personal data -
  never commit it or names from it). Not yet tested against the real panel: object types the panel
  really exposes, accepted modes, whether LifeSafetyOperation on the device object resets the
  panel, and whether the panel sends COV/events to us are still to be confirmed in the field
  (`info.objectTypes` and the log line "Panel ... objects (...)" help).

## Field log

- 0.1.0 on the real panel: every request answered with Class:5 Code:29 (service-request-denied),
  so network/port are fine. Assumed cause: the panel only accepts the client after learning its
  address from I-Am (Who-Is broadcasts don't cross the owner's VLANs) -> 0.1.1 sends I-Am unicast
  to the panel before connecting. Other candidates if it persists: client ID mismatch, BACnet
  license (site export shows installedLicense NOT_PRESENT on the panel element), access rights.
- 0.1.1 still denied (Code:29). 0.1.2 adds diagnosis (panel's I-Am; whether the panel ever contacts us)
  and optional foreign device registration at the panel as BBMD (needs 'BBMD freigeben' in the panel).
- 0.1.2 field result: panel answers Who-Is (device 1, vendor 7); FD registration accepted (BBMD + FDT
  enabled), but after 40+ min the panel never contacted client 10 and still denies (Code:29). Most
  likely cause: no BACnet license on the panel. The owner asked to trick the license check - declined;
  offered alternatives: obtain the license, or wire the panel's fire/fault outputs to SPC zones
  (ioBroker.spc-edp).
- With the BACnet license installed it connects (0.1.3): 136 objects (point 18, zone 114 incl. hardware
  like loops/stubs/panel, msv 3, bv 1, structured view 166, notification class 25, types 48/318).
  Open: duplicate names ("Stich 21" on two line cards), info-log noise after connect, BBMD renewal log.
- 0.1.4: admin title starts with "FC20". The owner then renamed the GitHub repo to
  ioBroker.fc20-cerberus-bacnet. `iobroker url` derives the adapter name from the repo name, so
  installing failed ("Cannot install ...: 0", exit 25) while the package was still
  iobroker.cerberus-bacnet -> 0.2.0 renames the adapter ID to `fc20-cerberus-bacnet` (new instance;
  the old cerberus-bacnet adapter has to be removed by the owner). Repo name and adapter ID must match.
- 0.2.0 confirmed by the owner on the real FC2040: reading works and disabling/enabling detectors
  (MODE write with allowControl) works as intended.
- 0.3.0 (owner chose the folder layout, paths changed from objects.point_<n>): folders by kind,
  internal objects hidden, info log only when alarm/pre-alarm/fault/disabled flags change,
  BBMD renewal logged once.
- 0.3.0 field: owner had to send mode on/off twice. The panel acks WriteProperty at once but applies
  the mode a moment later; the immediate refresh read the old mode and wrote it back (ack) -> 0.3.1
  `_confirm()` re-reads up to 8 s until the new mode shows (fake: `slowMode`).
- 0.3.1: still two attempts needed on the real panel. Suspected: old cerberus-bacnet.0 still running;
  the socket had reuseAddr: true, so both instances silently shared port 47808 and answers went to
  either -> 0.3.2 reuseAddr false + clear EADDRINUSE error. Owner asked to check for the old instance.
- Old instance was already deleted, still two attempts. 0.3.3 logs (info) mode/value before, write ack
  time and what the panel reports after the command, to see what the first write does.
- With 0.3.3 the owner reports switching works with one command again. Exact cause not proven
  (0.3.1 confirm loop / 0.3.2 port handling / restart); the command log lines stay for diagnosis.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.fc20-cerberus-bacnet`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses or data from the site export in the repository.
