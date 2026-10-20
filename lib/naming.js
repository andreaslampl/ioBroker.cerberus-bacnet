'use strict';

/*
 * Readable structure for the panel's objects. Cerberus PRO object names look like
 * "LP_SENSOR_AUTOMATIC_1/2_1/1883": prefix (LP = point, LZ = zone), kind, element address,
 * element ID. The kind decides the folder, the description (customer text) the name.
 */

const CATEGORIES = {
    melder: { de: 'Melder', en: 'Detectors' },
    sounder: { de: 'Sounder', en: 'Sounders' },
    ein_ausgaenge: { de: 'Ein- und Ausgänge', en: 'Inputs and outputs' },
    bereiche: { de: 'Bereiche und Gruppen', en: 'Areas and zones' },
    steuerungen: { de: 'Steuerungen', en: 'Controls' },
    bedienung: { de: 'Bedienung', en: 'Operating panels' },
    hardware: { de: 'Hardware', en: 'Hardware' },
    system: { de: 'System', en: 'System' },
    intern: { de: 'Interne Objekte', en: 'Internal objects' },
};

/** [kind pattern, category, name used when the panel has no customer text] - first match wins */
const RULES = [
    [/^SENSOR|^MANUAL|^DETECTOR/, 'melder', 'Melder'],
    [/^SOUNDER_BASE/, 'sounder', 'Sockel-Sounder'],
    [/^SOUNDER_EVAC/, 'sounder', 'EVAK-Sounder'],
    [/^SOUNDER/, 'sounder', 'Sounder'],
    [/^CAUSE_GROUP|^EFFECT_GROUP|^BACNET_LINE_SUMMARY|^IC$|^STANDARD_VISIBILITY|^TOOL$|^CTRL_LOGGING|^BACNET_SUB_AREA/, 'intern', ''],
    [/^CHANNEL_PHYS/, 'ein_ausgaenge', 'Kanal'],
    [/^OUTPUT/, 'steuerungen', 'Ausgang'],
    [/^INPUT/, 'steuerungen', 'Eingang'],
    [/^EFFECT_REQUEST/, 'steuerungen', 'Befehl'],
    [/^CTRL_EVAC/, 'steuerungen', 'Sirenensteuerung'],
    [/^CTRL_SOUNDER_INTERNAL/, 'steuerungen', 'Steuerung interner Summer'],
    [/^CTRL/, 'steuerungen', 'Steuerung'],
    [/^GROUP_FIRE/, 'steuerungen', 'Steuergruppe'],
    [/^GROUP_ALARM/, 'steuerungen', 'Alarmierungs-Steuergruppe'],
    [/^GROUP_EVAC/, 'steuerungen', 'Sirenen-Steuergruppe'],
    [/^GROUP_COUNTER/, 'system', 'Alarmzähler'],
    [/^AREA_FIRE_DETECTION/, 'bereiche', 'Detektions-Objekt'],
    [/^AREA/, 'bereiche', 'Stations-Objekt'],
    [/^SECTION/, 'bereiche', 'Abschnitt'],
    [/^ZONE/, 'bereiche', 'Gruppe'],
    [/^PMI|^FATFBF|^BUZZER/, 'bedienung', 'Bedienfeld'],
    [/^NETWORK_LEGACY/, 'system', 'SIGMANET'],
    [/^NETWORK/, 'system', 'Netzwerk'],
    [/^BACNET|^BLOCK/, 'system', 'BACnet'],
    [/^PANEL|^MODULE|^SUBMODULE|^FIRMWARE|^LINE|^DEVICE|^POWER|^VISUALIZER/, 'hardware', ''],
];

/** "LP_SENSOR_AUTOMATIC_1/2_1/1883" -> {kind: "SENSOR_AUTOMATIC", address: "1/2"} */
function parseName(objectName) {
    const m = /^(?:L[PZ]|MV|BV|[A-Z]{2})_([A-Z0-9_]+?)_(\d[\d/]*)_\d+\/\d+$/.exec(String(objectName || ''));
    return m ? { kind: m[1], address: m[2] } : null;
}

function technical(text, objectName) {
    return !text || text === objectName || /^[A-Z]{2}_[A-Z0-9_]+_\d/.test(text);
}

/** Object ID part from a name: "Brand Küche" -> "brand_kueche". */
function slug(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Folder, readable name and state ID for every object.
 *
 * @param {Array<{key: string, type: number, name: string, description: string}>} objects
 * @returns {Map<string, {category: string, name: string, id: string, address: string}>} by object key
 */
function arrange(objects) {
    const out = new Map();
    const parsed = new Map(objects.map(o => [o.key, parseName(o.name)]));
    // detector names by address, for the sounder base sitting on the same detector
    const detectorAt = new Map();
    for (const o of objects) {
        const p = parsed.get(o.key);
        if (p && /^SENSOR|^MANUAL|^DETECTOR/.test(p.kind) && !technical(o.description, o.name)) {
            detectorAt.set(p.address, o.description);
        }
    }
    for (const o of objects) {
        const p = parsed.get(o.key);
        const rule = p ? RULES.find(([re]) => re.test(p.kind)) : null;
        let category = rule ? rule[1] : 'system';
        // channels of loop devices (panel/module/line/device/channel) belong to the hardware,
        // only the panel's own I/Os (panel/module/channel) are real inputs and outputs
        if (category === 'ein_ausgaenge' && p.address.split('/').length > 3) {
            category = 'hardware';
        }
        let name = technical(o.description, o.name) ? '' : o.description;
        if (!name) {
            name = rule && rule[2] ? `${rule[2]}${p.address ? ` ${p.address}` : ''}` : o.description || o.name;
        }
        if (p && /^SOUNDER_BASE/.test(p.kind)) {
            const detector = detectorAt.get(p.address.split('/').slice(0, -1).join('/'));
            if (detector) {
                name = `${name} ${detector.replace(/^Brand\s+/i, '')}`;
            }
        }
        out.set(o.key, { category, name, address: p ? p.address : '' });
    }
    // same name twice in a folder (two line cards both have "Stich 21"): add the address
    const count = new Map();
    for (const a of out.values()) {
        count.set(`${a.category}|${a.name}`, (count.get(`${a.category}|${a.name}`) || 0) + 1);
    }
    for (const a of out.values()) {
        if (count.get(`${a.category}|${a.name}`) > 1 && a.address && !a.name.endsWith(a.address)) {
            a.name = `${a.name} (${a.address})`;
        }
    }
    // IDs unique within the folder
    const used = new Set();
    for (const [key, a] of out) {
        let id = slug(a.name) || key;
        if (used.has(`${a.category}.${id}`)) {
            id = `${id}_${key.split('_').pop()}`;
        }
        used.add(`${a.category}.${id}`);
        a.id = `${a.category}.${id}`;
    }
    return out;
}

module.exports = { arrange, parseName, CATEGORIES, slug };
