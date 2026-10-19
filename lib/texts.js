'use strict';

/* German texts for BACnet enumerations, and which states count as alarm / fault. */

const LIFE_SAFETY_STATE = {
    0: 'Ruhe',
    1: 'Voralarm',
    2: 'Alarm',
    3: 'Störung',
    4: 'Störung + Voralarm',
    5: 'Störung + Alarm',
    6: 'Nicht bereit',
    7: 'Aktiv',
    8: 'Sabotage',
    9: 'Test-Alarm',
    10: 'Test aktiv',
    11: 'Test-Störung',
    12: 'Test Störung + Alarm',
    13: 'Überfall',
    14: 'Bedrohung',
    15: 'Sabotage-Alarm',
    16: 'Abnormal',
    17: 'Notstrom',
    18: 'Verzögert',
    19: 'Gesperrt',
    20: 'Lokaler Alarm',
    21: 'Allgemeiner Alarm',
    22: 'Überwachung',
    23: 'Test-Überwachung',
};

const LIFE_SAFETY_MODE = {
    0: 'Aus',
    1: 'Ein',
    2: 'Test',
    3: 'Tag (besetzt)',
    4: 'Nacht (unbesetzt)',
    5: 'Scharf',
    6: 'Unscharf',
    7: 'Vorscharf',
    8: 'Langsam',
    9: 'Schnell',
    10: 'Getrennt',
    11: 'Eingeschaltet',
    12: 'Abgeschaltet',
    13: 'Automatische Auslösung gesperrt',
    14: 'Standard',
};

const EVENT_STATE = { 0: 'Normal', 1: 'Störung', 2: 'Offnormal', 3: 'Grenzwert hoch', 4: 'Grenzwert tief', 5: 'Lebenssicherheit-Alarm' };

const OPERATION = { silence: 1, silenceAudible: 2, silenceVisual: 3, reset: 4, resetAlarm: 5, resetFault: 6, unsilence: 7 };

/** Life safety states that are an alarm (fire, local/general alarm ...). */
const ALARM_STATES = new Set([2, 5, 12, 13, 14, 15, 20, 21]);
const PRE_ALARM_STATES = new Set([1, 4]);
const FAULT_STATES = new Set([3, 4, 5, 11, 12]);
/** Modes meaning "switched off" (Abschaltung). */
const OFF_MODES = new Set([0, 10, 12, 13]);

/** Short object type names used in object IDs. */
const TYPE_NAMES = {
    0: { id: 'ai', de: 'Analogeingang' },
    1: { id: 'ao', de: 'Analogausgang' },
    2: { id: 'av', de: 'Analogwert' },
    3: { id: 'bi', de: 'Binäreingang' },
    4: { id: 'bo', de: 'Binärausgang' },
    5: { id: 'bv', de: 'Binärwert' },
    8: { id: 'device', de: 'Gerät' },
    13: { id: 'msi', de: 'Mehrstufiger Eingang' },
    14: { id: 'mso', de: 'Mehrstufiger Ausgang' },
    19: { id: 'msv', de: 'Mehrstufiger Wert' },
    21: { id: 'point', de: 'Melder / Punkt' },
    22: { id: 'zone', de: 'Zone / Bereich' },
};

module.exports = {
    LIFE_SAFETY_STATE,
    LIFE_SAFETY_MODE,
    EVENT_STATE,
    OPERATION,
    ALARM_STATES,
    PRE_ALARM_STATES,
    FAULT_STATES,
    OFF_MODES,
    TYPE_NAMES,
};
