'use strict';

const utils = require('@iobroker/adapter-core');
const { BacnetLink, Bacnet } = require('./lib/link');
const { Panel } = require('./lib/panel');
const T = require('./lib/texts');
const { arrange, CATEGORIES } = require('./lib/naming');

const OT = Bacnet.ObjectType;

class CerberusBacnet extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'fc20-cerberus-bacnet' });
        this.link = null;
        this.panel = null;
        this.known = new Set();
        this.layout = new Map(); // object key -> {category, name, id}
        this.byPath = new Map(); // "melder.brand_kueche" -> object key
        this.lastFlags = new Map();
        this.quietUntil = 0;
        this.last = new Map();
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    get control() {
        return Boolean(this.config.allowControl);
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const host = String(this.config.host || '').trim();
        if (!host) {
            this.log.error('No IP address of the fire panel configured');
            return;
        }
        this.link = new BacnetLink({
            deviceId: Number(this.config.clientId) || 10,
            port: Number(this.config.localPort) || 47808,
            bind: String(this.config.bind || '').trim(),
            timeout: (Number(this.config.timeout) || 6) * 1000,
            log: this.log,
        });
        this.link.on('error', err => this.log.warn(`BACnet: ${err.message}`));
        this.panel = new Panel({
            link: this.link,
            address: host,
            deviceId: Number(this.config.deviceId) || 1,
            log: this.log,
            pollInterval: (Number(this.config.pollInterval) || 30) * 1000,
            foreignDevice: Boolean(this.config.foreignDevice),
        });
        // One after another: overlapping updates could otherwise write an older summary last.
        this.panel.on('online', on => this._queue(() => this.onOnline(on)));
        this.panel.on('objects', list => this._queue(() => this.onObjects(list)));
        this.panel.on('change', o => this._queue(() => this.onChange(o)));
        this.panel.on('notification', n => this.onNotification(n).catch(() => {}));
        this.subscribeStates('*');
        this.log.info(
            `Connecting to fire panel ${host} as BACnet client device ${this.link.deviceId}` +
                (this.control ? ' (commands allowed)' : ' (read only)'),
        );
        await this.panel.start();
    }

    _queue(fn) {
        this.queue = (this.queue || Promise.resolve()).then(fn).catch(err => this.log.warn(err.message));
        return this.queue;
    }

    async _set(id, val) {
        if (this.last.get(id) !== val) {
            this.last.set(id, val);
            await this.setState(id, val, true);
        }
    }

    async onOnline(on) {
        await this._set('info.connection', on);
        if (on) {
            const i = this.panel.info;
            await this._set('info.panel', [i.name, i.model, i.firmware].filter(Boolean).join(' / '));
            await this._set('info.objectTypes', JSON.stringify(i.objectTypes || {}));
        }
    }

    // ---- objects ----

    _stateText(o) {
        const v = o.presentValue;
        if (v === undefined || v === null) {
            return '';
        }
        if (o.lifeSafety) {
            return T.LIFE_SAFETY_STATE[v] || String(v);
        }
        if ([OT.BINARY_INPUT, OT.BINARY_OUTPUT, OT.BINARY_VALUE].includes(o.type)) {
            return v ? o.activeText || 'Ein' : o.inactiveText || 'Aus';
        }
        if ([OT.MULTI_STATE_INPUT, OT.MULTI_STATE_OUTPUT, OT.MULTI_STATE_VALUE].includes(o.type)) {
            return o.stateText[v - 1] || String(v);
        }
        return String(v);
    }

    _flags(o) {
        const v = o.presentValue;
        return {
            alarm: o.lifeSafety ? T.ALARM_STATES.has(v) : false,
            preAlarm: o.lifeSafety ? T.PRE_ALARM_STATES.has(v) : false,
            fault: Boolean((o.statusFlags && o.statusFlags.fault) || (o.lifeSafety && T.FAULT_STATES.has(v))),
            disabled: Boolean(o.disabled),
        };
    }

    _path(o) {
        return `objects.${this.layout.get(o.key).id}`;
    }

    _label(o) {
        const l = this.layout.get(o.key);
        return l ? l.name : o.description || o.name;
    }

    async onObjects(list) {
        this.layout = arrange(list);
        const visible = list.filter(o => this.config.showAll || this.layout.get(o.key).category !== 'intern');
        this.known = new Set(visible.map(o => o.key));
        this.byPath = new Map(visible.map(o => [this.layout.get(o.key).id, o.key]));
        await this.extendObject('objects', { type: 'folder', common: { name: { en: 'Panel objects', de: 'Objekte der Zentrale' } }, native: {} });
        const folders = new Set(visible.map(o => this.layout.get(o.key).category));
        for (const f of folders) {
            await this.extendObject(`objects.${f}`, { type: 'folder', common: { name: CATEGORIES[f] || f }, native: {} });
        }
        for (const o of visible) {
            await this.createObjectStates(o);
        }
        await this.removeStale(folders);
        // the first values after (re)connecting are no news: no log lines for them
        this.quietUntil = Date.now() + 30000;
        for (const o of visible) {
            this.lastFlags.set(o.key, JSON.stringify(this._flags(o)));
            await this.writeObject(o);
        }
        await this.writeSummary();
    }

    /** Delete objects of the old flat layout and of objects that are gone or now hidden. */
    async removeStale(folders) {
        const all = await this.getForeignObjectsAsync(`${this.namespace}.objects.*`).catch(() => ({}));
        const keep = id => {
            const parts = id.split('.');
            if (parts.length === 1) {
                return folders.has(parts[0]);
            }
            return this.byPath.has(`${parts[0]}.${parts[1]}`);
        };
        for (const fullId of Object.keys(all || {})) {
            const id = fullId.slice(`${this.namespace}.objects.`.length);
            if (!keep(id)) {
                await this.delObjectAsync(`objects.${id}`).catch(() => {});
            }
        }
    }

    async createObjectStates(o) {
        const p = this._path(o);
        const typeName = (T.TYPE_NAMES[o.type] || { de: `Typ ${o.type}` }).de;
        await this.extendObject(p, {
            type: 'channel',
            common: { name: this._label(o), desc: `${typeName} ${o.objectId.instance}: ${o.name}` },
            native: { objectId: o.objectId, objectName: o.name },
        });
        const ro = (name, type, role, extra = {}) => ({ name, type, role, read: true, write: false, ...extra });
        const states = {
            name: ro({ en: 'Name', de: 'Name' }, 'string', 'text'),
            state: ro({ en: 'State', de: 'Zustand' }, 'string', 'text'),
            value: ro({ en: 'Present value', de: 'Wert' }, o.type === OT.BINARY_INPUT || o.type === OT.BINARY_OUTPUT || o.type === OT.BINARY_VALUE ? 'boolean' : 'number', 'value'),
            alarm: ro({ en: 'Alarm', de: 'Alarm' }, 'boolean', 'indicator.alarm.fire'),
            fault: ro({ en: 'Fault', de: 'Störung' }, 'boolean', 'indicator.maintenance'),
            disabled: ro({ en: 'Disabled', de: 'Abgeschaltet' }, 'boolean', 'indicator'),
        };
        if (o.lifeSafety) {
            states.preAlarm = ro({ en: 'Pre-alarm', de: 'Voralarm' }, 'boolean', 'indicator.alarm');
            const modes = o.acceptedModes.length ? o.acceptedModes : [o.mode].filter(m => m !== undefined);
            states.mode = ro({ en: 'Mode', de: 'Betriebsart' }, 'number', 'level.mode', {
                write: this.control,
                states: Object.fromEntries(modes.map(m => [m, T.LIFE_SAFETY_MODE[m] || String(m)])),
            });
            if (this.control) {
                states.reset = { name: { en: 'Reset', de: 'Rücksetzen' }, type: 'boolean', role: 'button', read: false, write: true };
                states.silence = { name: { en: 'Silence', de: 'Akustik ab' }, type: 'boolean', role: 'button', read: false, write: true };
            }
        }
        if (o.commandable && this.control) {
            states.value.write = true;
            states.value.role = states.value.type === 'boolean' ? 'switch' : 'level';
            if (o.stateText.length) {
                states.value.states = Object.fromEntries(o.stateText.map((t, i) => [i + 1, t]));
            }
        }
        for (const [k, common] of Object.entries(states)) {
            await this.extendObject(`${p}.${k}`, { type: 'state', common, native: {} });
        }
    }

    async writeObject(o) {
        const p = this._path(o);
        const f = this._flags(o);
        await this._set(`${p}.name`, this._label(o));
        await this._set(`${p}.state`, [this._stateText(o), f.disabled ? 'abgeschaltet' : ''].filter(Boolean).join(', '));
        const v = o.presentValue;
        await this._set(`${p}.value`, [OT.BINARY_INPUT, OT.BINARY_OUTPUT, OT.BINARY_VALUE].includes(o.type) ? Boolean(v) : v === undefined ? null : Number(v));
        await this._set(`${p}.alarm`, f.alarm);
        await this._set(`${p}.fault`, f.fault);
        await this._set(`${p}.disabled`, f.disabled);
        if (o.lifeSafety) {
            await this._set(`${p}.preAlarm`, f.preAlarm);
            await this._set(`${p}.mode`, o.mode === undefined ? null : o.mode);
        }
    }

    async writeSummary() {
        // internal objects (BACnet line summaries, cause/effect groups ...) would only repeat others
        const list = [...this.panel.objects.values()].filter(o => this.layout.has(o.key) && this.layout.get(o.key).category !== 'intern');
        const names = pred => list.filter(o => pred(this._flags(o))).map(o => this._label(o));
        const alarms = names(f => f.alarm);
        const faults = names(f => f.fault);
        const disabled = names(f => f.disabled);
        await this._set('summary.alarm', alarms.length > 0);
        await this._set('summary.alarmList', alarms.join(', '));
        await this._set('summary.preAlarm', names(f => f.preAlarm).length > 0);
        await this._set('summary.fault', faults.length > 0);
        await this._set('summary.faultList', faults.join(', '));
        await this._set('summary.disabled', disabled.length > 0);
        await this._set('summary.disabledList', disabled.join(', '));
    }

    async onChange(o) {
        if (!this.known.has(o.key)) {
            return;
        }
        await this.writeObject(o);
        await this.writeSummary();
        const flags = JSON.stringify(this._flags(o));
        const important = flags !== this.lastFlags.get(o.key);
        this.lastFlags.set(o.key, flags);
        const text = `${this._label(o)}: ${this._stateText(o)}${o.disabled ? ' (abgeschaltet)' : ''}`;
        // alarm/fault/disablement always; other changes only once the values after connecting are in
        if (important || Date.now() > this.quietUntil) {
            await this.setState('summary.lastChange', text, true);
        }
        if (important) {
            this.log.info(text);
        } else {
            this.log.debug(text);
        }
    }

    async onNotification(n) {
        if (n.messageText) {
            await this.setState('summary.lastMessage', String(n.messageText), true);
        }
    }

    // ---- commands ----

    async onStateChange(id, state) {
        if (!state || state.ack || !this.panel) {
            return;
        }
        const local = id.slice(this.namespace.length + 1);
        const m = /^objects\.(.+)\.(mode|reset|silence|value)$/.exec(local);
        const panelCmd = /^panel\.(reset|silence|unsilence)$/.exec(local);
        if (!m && !panelCmd) {
            return;
        }
        if (!this.control) {
            this.log.warn(`Commands are switched off in the settings (${local} ignored)`);
            return;
        }
        try {
            if (panelCmd) {
                if (state.val) {
                    this.log.info(`Panel: ${panelCmd[1]}`);
                    await this.panel.operation(null, T.OPERATION[panelCmd[1]]);
                }
                await this.setState(local, false, true);
                return;
            }
            const [, path, cmd] = m;
            const objKey = this.byPath.get(path) || path;
            const o = this.panel.objects.get(objKey);
            const label = o ? this._label(o) : path;
            if (cmd === 'mode') {
                this.log.info(`${label}: mode -> ${T.LIFE_SAFETY_MODE[state.val] || state.val}`);
                await this.panel.setMode(objKey, state.val);
            } else if (cmd === 'value') {
                this.log.info(`${label}: value -> ${state.val}`);
                await this.panel.writeValue(objKey, state.val, Number(this.config.priority) || 8);
            } else if (state.val) {
                this.log.info(`${label}: ${cmd}`);
                await this.panel.operation(objKey, T.OPERATION[cmd]);
            }
        } catch (err) {
            this.log.warn(`Command ${local} failed: ${err.message}`);
        }
        // confirm with the real value from the panel
        if (m) {
            const o = this.panel.objects.get(this.byPath.get(m[1]));
            if (m[2] === 'reset' || m[2] === 'silence') {
                await this.setState(local, false, true);
            } else if (o) {
                await this._queue(async () => {
                    this.last.delete(local);
                    await this.writeObject(o);
                });
            }
        }
    }

    async onUnload(callback) {
        try {
            if (this.panel) {
                this.panel.stop();
            }
            if (this.link) {
                this.link.close();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new CerberusBacnet(options);
} else {
    new CerberusBacnet();
}
