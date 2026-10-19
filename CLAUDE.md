# ioBroker.cerberus-bacnet

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
  (renewed before lifetime ends), polling as safety net/keep-alive, commands: MODE write,
  LifeSafetyOperation (device = whole panel), PRESENT_VALUE write with priority (null = relinquish).
- `lib/texts.js` – German texts for life safety state/mode, which states count as alarm/fault/off.
- `test/` – `node --test` against `test/fake-panel.js` (library as device on 127.0.0.1).

## Status

- Built from the owner's site export (Cerberus engineering tool XML, contains personal data -
  never commit it or names from it). Not yet tested against the real panel: object types the panel
  really exposes, accepted modes, whether LifeSafetyOperation on the device object resets the
  panel, and whether the panel sends COV/events to us are still to be confirmed in the field
  (`info.objectTypes` and the log line "Panel ... objects (...)" help).

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.cerberus-bacnet`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses or data from the site export in the repository.
