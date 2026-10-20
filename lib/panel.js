'use strict';

/*
 * The fire panel as seen over BACnet: reads the object list and all relevant objects,
 * keeps them current (COV subscriptions + polling as safety net and keep-alive) and sends
 * commands (mode on/off, reset/silence, outputs).
 */

const { EventEmitter } = require('node:events');
const { Bacnet } = require('./link');
const { TYPE_NAMES, OFF_MODES } = require('./texts');

const P = Bacnet.PropertyIdentifier;
const OT = Bacnet.ObjectType;
const LS_TYPES = new Set([OT.LIFE_SAFETY_POINT, OT.LIFE_SAFETY_ZONE]);
const BINARY = new Set([OT.BINARY_INPUT, OT.BINARY_OUTPUT, OT.BINARY_VALUE]);
const MULTI = new Set([OT.MULTI_STATE_INPUT, OT.MULTI_STATE_OUTPUT, OT.MULTI_STATE_VALUE]);
const ANALOG = new Set([OT.ANALOG_INPUT, OT.ANALOG_OUTPUT, OT.ANALOG_VALUE]);
/** Objects whose present value a client may command. */
const COMMANDABLE = new Set([OT.BINARY_OUTPUT, OT.BINARY_VALUE, OT.MULTI_STATE_OUTPUT, OT.MULTI_STATE_VALUE, OT.ANALOG_OUTPUT, OT.ANALOG_VALUE]);

const STATUS_PROPS = [P.PRESENT_VALUE, P.STATUS_FLAGS, P.EVENT_STATE, P.OUT_OF_SERVICE];

function first(values) {
    if (!Array.isArray(values) || !values.length) {
        return undefined;
    }
    const v = values[0];
    if (v && v.type === Bacnet.ApplicationTag.ERROR) {
        return undefined;
    }
    return v ? v.value : undefined;
}

/** All values of a list property (accepted modes, state texts), without error entries. */
function all(values) {
    return (Array.isArray(values) ? values : []).filter(v => v && v.type !== Bacnet.ApplicationTag.ERROR).map(v => v.value);
}

function statusFlags(v) {
    const bits = v && Array.isArray(v.value) ? v.value[0] || 0 : 0;
    return { inAlarm: Boolean(bits & 1), fault: Boolean(bits & 2), overridden: Boolean(bits & 4), outOfService: Boolean(bits & 8) };
}

/** BACnet errors in words, with hints for the usual causes. */
function describe(err) {
    const m = /Class:(\d+) - Code:(\d+)/.exec(err.message);
    if (m && m[2] === '29') {
        return (
            'the panel refuses the request (service-request-denied). Check that the client ID in the settings ' +
            'equals the "BACnet Device ID" of the BACnet client in the panel, that the client has access rights, and ' +
            'that BACnet is licensed/enabled in the panel'
        );
    }
    if (m) {
        const cls = Bacnet.ErrorClass[m[1]] || m[1];
        const code = Bacnet.ErrorCode[m[2]] || m[2];
        return `${err.message} (${cls}/${code})`;
    }
    if (/timeout/i.test(err.message)) {
        return 'no answer (check IP address, port 47808/UDP in both directions, firewall)';
    }
    return err.message;
}

/** Errors meaning "this service is not supported" (Reject: unrecognized service). */
function unsupported(err) {
    return /Abort - Reason:9\b|Code:67\b/.test(err.message);
}

function key(objectId) {
    const t = TYPE_NAMES[objectId.type];
    return `${t ? t.id : `type${objectId.type}`}_${objectId.instance}`;
}

class Panel extends EventEmitter {
    /**
     * @param {object} options
     * @param {import('./link').BacnetLink} options.link
     * @param {string} options.address panel IP (optionally :port)
     * @param {number} options.deviceId panel device instance
     */
    constructor({ link, address, deviceId, log, pollInterval = 30000, covLifetime = 3600, batch = 4, foreignDevice = false }) {
        super();
        this.link = link;
        this.address = /:\d+$/.test(address) ? address : `${address}:47808`;
        this.deviceId = deviceId;
        this.device = { type: OT.DEVICE, instance: deviceId };
        this.log = log;
        this.pollInterval = pollInterval;
        this.covLifetime = covLifetime;
        this.batch = batch;
        this.objects = new Map(); // key -> object
        this.info = {};
        this.online = false;
        this.rpm = true; // ReadPropertyMultiple supported (until proven otherwise)
        this.cov = true;
        this.timer = null;
        this.covTimer = null;
        this.failures = 0;
        this.foreignDevice = foreignDevice;
        this.seenRequests = new Set();
        link.on('request', (service, from) => {
            // Diagnosis: the panel contacting its BACnet client shows that it found us.
            if (from && from.replace(/:\d+$/, '') === this.address.replace(/:\d+$/, '') && !this.seenRequests.has(service)) {
                this.seenRequests.add(service);
                this.log.info(`Panel contacts us as its BACnet client (${service})`);
            }
        });
        link.on('cov', p => this._onCov(p));
        link.on('event', p => this._onEvent(p));
    }

    async start() {
        if (this.foreignDevice) {
            await this._registerForeign();
        }
        await this._connect().catch(err => this._offline(err));
        if (!this.online) {
            await this._diagnose();
        }
        const loop = async () => {
            if (this.timer === null) {
                return;
            }
            if (this.online) {
                await this.poll().catch(err => this._offline(err));
            } else {
                await this._connect().catch(err => this._offline(err));
            }
            if (this.timer !== null) {
                this.timer = setTimeout(loop, this.pollInterval);
            }
        };
        this.timer = setTimeout(loop, this.pollInterval);
    }

    async _registerForeign() {
        clearTimeout(this.fdTimer);
        try {
            await this.link.registerForeignDevice(this.address, 300);
            // renewed every 4 minutes: only the first registration is news
            this.log[this.fdRegistered ? 'debug' : 'info'](`Registered as foreign device at ${this.address} (BBMD)`);
            this.fdRegistered = true;
        } catch (err) {
            this.log.warn(`Foreign device registration at ${this.address} failed: ${err.message} (is BBMD enabled in the panel?)`);
        }
        this.fdTimer = setTimeout(() => this._registerForeign(), 240000);
    }

    /** Logged once when the first connection fails: what the panel tells about itself. */
    async _diagnose() {
        const iam = await this.link.whoIs(this.address).catch(() => null);
        if (!iam) {
            this.log.warn(`Diagnosis: the panel does not answer Who-Is at ${this.address}`);
            return;
        }
        this.log.info(
            `Diagnosis: panel answers Who-Is as device ${iam.deviceId} (vendor ${iam.vendorId})` +
                (iam.deviceId !== this.deviceId ? ` - but the settings say device ${this.deviceId}!` : ''),
        );
        if (!this.seenRequests.size) {
            this.log.info(
                'Diagnosis: the panel has not contacted us as its BACnet client yet. Across subnets/VLANs it cannot ' +
                    'find client devices by broadcast: enable BBMD in the panel and "register as foreign device" in the settings',
            );
        }
    }

    stop() {
        clearTimeout(this.fdTimer);
        clearTimeout(this.timer);
        clearTimeout(this.covTimer);
        this.timer = null;
        this.covTimer = null;
    }

    _offline(err) {
        this.failures++;
        if (this.online || this.failures === 1) {
            this.log.warn(`Panel ${this.address}: ${describe(err)}`);
        }
        if (this.online && this.failures >= 2) {
            this.online = false;
            this.emit('online', false);
        }
    }

    // ---- reading ----

    async _readProps(objectId, props) {
        const out = {};
        if (this.rpm) {
            try {
                const [res] = await this.link.readMultiple(this.address, [{ objectId, properties: props }]);
                for (const v of res.values) {
                    out[v.id] = v.value;
                }
                return out;
            } catch (err) {
                if (!unsupported(err)) {
                    throw err;
                }
                this.log.info('Panel does not support ReadPropertyMultiple, reading single properties');
                this.rpm = false;
            }
        }
        return this._readEach(objectId, props, out);
    }

    async _readEach(objectId, props, out = {}) {
        for (const id of props) {
            try {
                out[id] = await this.link.read(this.address, objectId, id);
            } catch (err) {
                if (/timeout/i.test(err.message)) {
                    throw err;
                }
                // property not present in this object
            }
        }
        return out;
    }

    /** Several objects with the same properties; RPM in batches when possible. */
    async _readMany(objects, propsFor) {
        if (!this.rpm) {
            const out = [];
            for (const o of objects) {
                out.push(await this._readProps(o.objectId, propsFor(o)));
            }
            return out;
        }
        const out = [];
        for (let i = 0; i < objects.length; i += this.batch) {
            const part = objects.slice(i, i + this.batch);
            try {
                const res = await this.link.readMultiple(
                    this.address,
                    part.map(o => ({ objectId: o.objectId, properties: propsFor(o) })),
                );
                for (const r of res) {
                    const vals = {};
                    for (const v of r.values) {
                        vals[v.id] = v.value;
                    }
                    out.push(vals);
                }
            } catch (err) {
                if (/timeout/i.test(err.message)) {
                    throw err;
                }
                // one object in the batch may have rejected the whole request: read one by one
                for (const o of part) {
                    out.push(await this._readProps(o.objectId, propsFor(o)));
                }
            }
        }
        return out;
    }

    async _objectList() {
        try {
            return (await this.link.read(this.address, this.device, P.OBJECT_LIST)).map(v => v.value);
        } catch (err) {
            if (/timeout/i.test(err.message)) {
                throw err;
            }
            // too long for one answer without segmentation: read it element by element
            const count = first(await this.link.read(this.address, this.device, P.OBJECT_LIST, 0));
            const list = [];
            for (let i = 1; i <= count; i++) {
                list.push(first(await this.link.read(this.address, this.device, P.OBJECT_LIST, i)));
            }
            return list;
        }
    }

    async _connect() {
        this.link.announce(this.address);
        await new Promise(r => setTimeout(r, 300));
        const dev = await this._readProps(this.device, [
            P.OBJECT_NAME,
            P.MODEL_NAME,
            P.VENDOR_NAME,
            P.FIRMWARE_REVISION,
            P.APPLICATION_SOFTWARE_VERSION,
            P.DATABASE_REVISION,
        ]);
        // changes with every configuration download: then the object list is read again (see poll)
        this.dbRevision = first(dev[P.DATABASE_REVISION]);
        this.info = {
            name: first(dev[P.OBJECT_NAME]) || '',
            model: first(dev[P.MODEL_NAME]) || '',
            vendor: first(dev[P.VENDOR_NAME]) || '',
            firmware: first(dev[P.APPLICATION_SOFTWARE_VERSION]) || first(dev[P.FIRMWARE_REVISION]) || '',
        };
        const list = await this._objectList();
        this.objectCount = list.length;
        this.pollCount = 0;
        const counts = {};
        const wanted = [];
        for (const id of list) {
            if (!id) {
                continue;
            }
            counts[id.type] = (counts[id.type] || 0) + 1;
            if (TYPE_NAMES[id.type] && id.type !== OT.DEVICE) {
                wanted.push({ objectId: { type: id.type, instance: id.instance }, key: key(id) });
            }
        }
        this.info.objectTypes = counts;
        const details = await this._readMany(wanted, o => this._allProps(o.objectId.type));
        this.objects.clear();
        for (const [i, o] of wanted.entries()) {
            this.objects.set(o.key, this._build(o, details[i]));
        }
        this.log.info(
            `Panel "${this.info.name}" (${this.info.model}, ${this.info.firmware}): ${this.objects.size} objects ` +
                `(${Object.entries(counts).map(([t, n]) => `${(TYPE_NAMES[t] && TYPE_NAMES[t].id) || `type ${t}`}: ${n}`).join(', ')})`,
        );
        this.failures = 0;
        this.online = true;
        this.emit('objects', [...this.objects.values()]);
        this.emit('online', true);
        await this._subscribeAll();
        // anything that changed between reading and subscribing
        await this.poll();
    }

    _allProps(type) {
        const props = [P.OBJECT_NAME, P.DESCRIPTION, ...STATUS_PROPS];
        if (LS_TYPES.has(type)) {
            props.push(P.MODE, P.ACCEPTED_MODES, P.RELIABILITY);
        } else if (BINARY.has(type)) {
            props.push(P.ACTIVE_TEXT, P.INACTIVE_TEXT);
        } else if (MULTI.has(type)) {
            props.push(P.STATE_TEXT);
        } else if (ANALOG.has(type)) {
            props.push(P.UNITS);
        }
        return props;
    }

    _statusProps(type) {
        return LS_TYPES.has(type) ? [...STATUS_PROPS, P.MODE] : STATUS_PROPS;
    }

    _build(o, vals) {
        const type = o.objectId.type;
        const obj = {
            key: o.key,
            objectId: o.objectId,
            type,
            lifeSafety: LS_TYPES.has(type),
            commandable: COMMANDABLE.has(type),
            name: String(first(vals[P.OBJECT_NAME]) || o.key),
            description: String(first(vals[P.DESCRIPTION]) || ''),
            acceptedModes: all(vals[P.ACCEPTED_MODES]).filter(v => typeof v === 'number'),
            reliability: first(vals[P.RELIABILITY]),
            activeText: first(vals[P.ACTIVE_TEXT]) || '',
            inactiveText: first(vals[P.INACTIVE_TEXT]) || '',
            stateText: all(vals[P.STATE_TEXT]).map(String),
            units: first(vals[P.UNITS]),
        };
        this._apply(obj, vals);
        return obj;
    }

    /** Take over status values; returns true if something changed. */
    _apply(obj, vals) {
        const before = JSON.stringify([obj.presentValue, obj.statusFlags, obj.eventState, obj.outOfService, obj.mode]);
        if (P.PRESENT_VALUE in vals) {
            const v = first(vals[P.PRESENT_VALUE]);
            obj.presentValue = typeof v === 'number' && ANALOG.has(obj.type) ? Math.round(v * 100) / 100 : v;
        }
        if (P.STATUS_FLAGS in vals) {
            obj.statusFlags = statusFlags(first(vals[P.STATUS_FLAGS]));
        }
        if (P.EVENT_STATE in vals) {
            obj.eventState = first(vals[P.EVENT_STATE]);
        }
        if (P.OUT_OF_SERVICE in vals) {
            obj.outOfService = Boolean(first(vals[P.OUT_OF_SERVICE]));
        }
        if (P.MODE in vals) {
            obj.mode = first(vals[P.MODE]);
        }
        obj.disabled = Boolean(obj.outOfService || (obj.lifeSafety && OFF_MODES.has(obj.mode)));
        return before !== JSON.stringify([obj.presentValue, obj.statusFlags, obj.eventState, obj.outOfService, obj.mode]);
    }

    async poll() {
        const list = [...this.objects.values()];
        if (await this._configChanged()) {
            this.log.info('Panel configuration changed, reading all objects again');
            await this._connect();
            return;
        }
        const started = Date.now();
        const vals = await this._readMany(list, o => this._statusProps(o.type));
        this.failures = 0;
        for (const [i, o] of list.entries()) {
            // a COV that arrived while we were reading is newer than what we read
            if (o.covAt >= started) {
                continue;
            }
            if (this._apply(o, vals[i])) {
                this.emit('change', o);
            }
        }
    }

    /**
     * Was the panel extended / reconfigured? Database revision if the panel has it (also the
     * keep-alive), otherwise the length of the object list every 20th poll.
     */
    async _configChanged() {
        if (this.dbRevision !== undefined) {
            const rev = first(await this.link.read(this.address, this.device, P.DATABASE_REVISION));
            return rev !== undefined && rev !== this.dbRevision;
        }
        this.pollCount = (this.pollCount || 0) + 1;
        if (this.pollCount % 20 !== 0) {
            if (!this.objects.size) {
                await this.link.read(this.address, this.device, P.OBJECT_NAME); // keep-alive
            }
            return false;
        }
        const count = first(await this.link.read(this.address, this.device, P.OBJECT_LIST, 0));
        return typeof count === 'number' && count !== this.objectCount;
    }

    async refresh(objKey) {
        const o = this.objects.get(objKey);
        if (!o) {
            return;
        }
        const started = Date.now();
        const vals = await this._readProps(o.objectId, this._statusProps(o.type));
        if (!(o.covAt >= started) && this._apply(o, vals)) {
            this.emit('change', o);
        }
    }

    async _subscribeAll() {
        clearTimeout(this.covTimer);
        if (!this.cov) {
            return;
        }
        let ok = 0;
        for (const o of this.objects.values()) {
            try {
                await this.link.subscribe(this.address, o.objectId, this.link.deviceId, this.covLifetime);
                ok++;
            } catch (err) {
                if (ok === 0) {
                    this.log.info(`Panel: no change notifications (COV: ${err.message}), polling every ${this.pollInterval / 1000} s`);
                    this.cov = false;
                    return;
                }
            }
        }
        this.log.debug(`COV subscribed for ${ok} objects`);
        this.covTimer = setTimeout(() => this._subscribeAll().catch(() => {}), Math.max(60, this.covLifetime - 300) * 1000);
    }

    _onCov(p) {
        if (!p || !p.monitoredObjectId) {
            return;
        }
        const o = this.objects.get(key(p.monitoredObjectId));
        if (!o) {
            return;
        }
        const vals = {};
        for (const v of p.values || []) {
            vals[v.property.id] = v.value;
        }
        o.covAt = Date.now();
        if (this._apply(o, vals)) {
            this.emit('change', o);
        }
    }

    _onEvent(p) {
        if (p && p.eventObjectIdentifier) {
            this.emit('notification', p);
            this.refresh(key(p.eventObjectIdentifier)).catch(() => {});
        }
    }

    // ---- commands ----

    _obj(objKey) {
        const o = this.objects.get(objKey);
        if (!o) {
            throw new Error(`Unknown object ${objKey}`);
        }
        return o;
    }

    async setMode(objKey, mode) {
        const o = this._obj(objKey);
        if (!o.lifeSafety) {
            throw new Error(`${o.name}: no life safety object`);
        }
        if (o.acceptedModes.length && !o.acceptedModes.includes(Number(mode))) {
            throw new Error(`${o.name}: mode ${mode} not accepted (allowed: ${o.acceptedModes.join(', ')})`);
        }
        const label = o.description || o.name;
        const t0 = Date.now();
        const before = `mode ${o.mode}, value ${o.presentValue}`;
        await this.link.write(this.address, o.objectId, P.MODE, [{ type: Bacnet.ApplicationTag.ENUMERATED, value: Number(mode) }]);
        // Diagnosis for commands that seem to need two attempts: what the panel reports and when.
        this.log.info(`${label}: panel acknowledged mode ${mode} after ${Date.now() - t0} ms (before: ${before})`);
        const ok = await this._confirm(objKey, x => x.mode === Number(mode));
        const after = `mode ${o.mode}, value ${o.presentValue}, out of service ${o.outOfService}`;
        if (ok) {
            this.log.info(`${label}: panel reports ${after} after ${Date.now() - t0} ms`);
        } else {
            this.log.warn(`${label}: the panel accepted the command but after ${Date.now() - t0} ms still reports ${after}`);
        }
    }

    /**
     * The panel acknowledges a command at once but takes a moment to carry it out. Read the object
     * again until it shows the result (or a COV brings it), so a stale value is not shown as the result.
     */
    async _confirm(objKey, done, timeout = 8000) {
        const o = this._obj(objKey);
        const end = Date.now() + timeout;
        for (;;) {
            await this.refresh(objKey);
            if (done(o)) {
                return true;
            }
            if (Date.now() > end) {
                return false;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /** Reset / silence ... for one object, or the whole panel when objKey is empty. */
    async operation(objKey, op) {
        const target = objKey ? this._obj(objKey).objectId : this.device;
        await this.link.lifeSafetyOperation(this.address, op, target);
        if (objKey) {
            await this.refresh(objKey);
        } else {
            await this.poll().catch(() => {});
        }
    }

    /** Command an output/value; null releases the command (relinquish). */
    async writeValue(objKey, value, priority) {
        const o = this._obj(objKey);
        if (!o.commandable) {
            throw new Error(`${o.name}: cannot be switched`);
        }
        const T = Bacnet.ApplicationTag;
        let data;
        if (value === null || value === undefined || value === '') {
            data = { type: T.NULL, value: null };
        } else if (BINARY.has(o.type)) {
            data = { type: T.ENUMERATED, value: value === true || Number(value) === 1 ? 1 : 0 };
        } else if (MULTI.has(o.type)) {
            data = { type: T.UNSIGNED_INTEGER, value: Math.max(1, Math.round(Number(value))) };
        } else {
            data = { type: T.REAL, value: Number(value) };
        }
        await this.link.write(this.address, o.objectId, P.PRESENT_VALUE, [data], priority);
        if (data.type === T.NULL) {
            await this.refresh(objKey); // released: the panel decides the value
        } else {
            await this._confirm(objKey, x => Number(x.presentValue) === Number(data.value), 5000);
        }
    }
}

module.exports = { Panel, key, statusFlags, first, describe };
