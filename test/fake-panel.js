'use strict';

/*
 * A simulated Cerberus PRO panel on 127.0.0.1 (BACnet device, using the same library).
 * Options: noRpm (rejects ReadPropertyMultiple), shortList (object list only by index).
 */

const { Bacnet } = require('../lib/link');

const B = Bacnet.default;
const P = Bacnet.PropertyIdentifier;
const OT = Bacnet.ObjectType;
const T = Bacnet.ApplicationTag;

function fakePanel({ port, deviceId = 1, clientId = 10, noRpm = false, shortList = false } = {}) {
    const dev = new B({ port, interface: '127.0.0.1', apduTimeout: 2000 });
    const objects = new Map();
    const add = (type, instance, props) => objects.set(`${type}:${instance}`, { objectId: { type, instance }, ...props });
    add(OT.DEVICE, deviceId, { name: 'FC2040', model: 'FC2040', firmware: '80.6.56' });
    add(OT.LIFE_SAFETY_ZONE, 1, { name: 'Z1', description: 'Gebäude', pv: 0, mode: 1, accepted: [1, 0], flags: 0 });
    add(OT.LIFE_SAFETY_POINT, 1, { name: 'P1', description: 'Melder Wohnraum', pv: 0, mode: 1, accepted: [1, 0], flags: 0 });
    add(OT.LIFE_SAFETY_POINT, 2, { name: 'P2', description: 'Melder Flur', pv: 0, mode: 1, accepted: [1, 0], flags: 0 });
    add(OT.BINARY_OUTPUT, 1, { name: 'BO1', description: 'Sirenen', pv: 0, active: 'Ein', inactive: 'Aus', flags: 0 });
    add(OT.BINARY_INPUT, 1, { name: 'BI1', description: 'Taster Quittieren', pv: 0, active: 'gedrückt', inactive: 'Ruhe', flags: 0 });
    add(OT.NOTIFICATION_CLASS, 1, { name: 'NC1' });
    const calls = [];
    const subscribers = new Map(); // key -> {address, processId}

    const value = (o, id) => {
        switch (id) {
            case P.OBJECT_NAME:
                return [{ type: T.CHARACTER_STRING, value: o.name }];
            case P.DESCRIPTION:
                return o.description === undefined ? null : [{ type: T.CHARACTER_STRING, value: o.description }];
            case P.MODEL_NAME:
                return o.model ? [{ type: T.CHARACTER_STRING, value: o.model }] : null;
            case P.APPLICATION_SOFTWARE_VERSION:
                return o.firmware ? [{ type: T.CHARACTER_STRING, value: o.firmware }] : null;
            case P.PRESENT_VALUE:
                return o.pv === undefined ? null : [{ type: T.ENUMERATED, value: o.pv }];
            case P.STATUS_FLAGS:
                return o.flags === undefined ? null : [{ type: T.BIT_STRING, value: { bitsUsed: 4, value: [o.flags] } }];
            case P.EVENT_STATE:
                return o.pv === undefined ? null : [{ type: T.ENUMERATED, value: 0 }];
            case P.OUT_OF_SERVICE:
                return o.pv === undefined ? null : [{ type: T.BOOLEAN, value: false }];
            case P.MODE:
                return o.mode === undefined ? null : [{ type: T.ENUMERATED, value: o.mode }];
            case P.ACCEPTED_MODES:
                return o.accepted ? o.accepted.map(m => ({ type: T.ENUMERATED, value: m })) : null;
            case P.ACTIVE_TEXT:
                return o.active ? [{ type: T.CHARACTER_STRING, value: o.active }] : null;
            case P.INACTIVE_TEXT:
                return o.inactive ? [{ type: T.CHARACTER_STRING, value: o.inactive }] : null;
            case P.OBJECT_LIST:
                return [...objects.values()].map(x => ({ type: T.OBJECTIDENTIFIER, value: x.objectId }));
            default:
                return null;
        }
    };
    const err = (c, cls, code) => dev.errorResponse(c.header.sender, c.service, c.invokeId, cls, code);

    dev.on('readProperty', c => {
        const { objectId, property } = c.payload;
        calls.push(`RP ${objectId.type}:${objectId.instance}.${property.id}`);
        const o = objects.get(`${objectId.type}:${objectId.instance}`);
        if (!o) {
            return err(c, Bacnet.ErrorClass.OBJECT, Bacnet.ErrorCode.UNKNOWN_OBJECT);
        }
        let v = value(o, property.id);
        if (property.id === P.OBJECT_LIST) {
            if (property.index === 0) {
                v = [{ type: T.UNSIGNED_INTEGER, value: objects.size }];
            } else if (property.index !== 0xffffffff) {
                v = [v[property.index - 1]];
            } else if (shortList) {
                return err(c, Bacnet.ErrorClass.SERVICES, Bacnet.ErrorCode.ABORT_SEGMENTATION_NOT_SUPPORTED || 2);
            }
        }
        if (!v) {
            return err(c, Bacnet.ErrorClass.PROPERTY, Bacnet.ErrorCode.UNKNOWN_PROPERTY);
        }
        dev.readPropertyResponse(c.header.sender, c.invokeId, objectId, property, v);
    });

    dev.on('readPropertyMultiple', c => {
        calls.push('RPM');
        if (noRpm) {
            return err(c, Bacnet.ErrorClass.SERVICES, Bacnet.ErrorCode.SERVICE_REQUEST_DENIED);
        }
        const out = c.payload.properties.map(spec => {
            const o = objects.get(`${spec.objectId.type}:${spec.objectId.instance}`);
            return {
                objectId: spec.objectId,
                values: spec.properties.map(pr => ({
                    property: { id: pr.id, index: 0xffffffff },
                    value: (o && value(o, pr.id)) || [{ value: { type: 'BacnetError', errorClass: Bacnet.ErrorClass.PROPERTY, errorCode: Bacnet.ErrorCode.UNKNOWN_PROPERTY } }],
                })),
            };
        });
        dev.readPropertyMultipleResponse(c.header.sender, c.invokeId, out);
    });

    const notify = key => {
        const s = subscribers.get(key);
        const o = objects.get(key);
        if (s && o) {
            dev.unconfirmedCOVNotification({ address: s.address }, s.processId, deviceId, o.objectId, 3000, [
                { property: { id: P.PRESENT_VALUE }, value: value(o, P.PRESENT_VALUE) },
                { property: { id: P.STATUS_FLAGS }, value: value(o, P.STATUS_FLAGS) },
                ...(o.mode !== undefined ? [{ property: { id: P.MODE }, value: value(o, P.MODE) }] : []),
            ]);
        }
    };

    dev.on('subscribeCov', c => {
        const id = c.payload.monitoredObjectId;
        calls.push(`SUB ${id.type}:${id.instance}`);
        subscribers.set(`${id.type}:${id.instance}`, { address: c.header.sender.address, processId: c.payload.subscriberProcessId });
        dev.simpleAckResponse(c.header.sender, c.service, c.invokeId);
    });

    dev.on('writeProperty', c => {
        const { objectId, value: v } = c.payload;
        const key = `${objectId.type}:${objectId.instance}`;
        const o = objects.get(key);
        calls.push(`WP ${key}.${v.property.id}=${JSON.stringify(v.value[0].value)}@${v.priority}`);
        if (v.property.id === P.MODE && o.accepted && o.accepted.includes(v.value[0].value)) {
            o.mode = v.value[0].value;
        } else if (v.property.id === P.PRESENT_VALUE && objectId.type === OT.BINARY_OUTPUT) {
            o.pv = v.value[0].value === null ? 0 : v.value[0].value;
        } else {
            return err(c, Bacnet.ErrorClass.PROPERTY, Bacnet.ErrorCode.WRITE_ACCESS_DENIED);
        }
        dev.simpleAckResponse(c.header.sender, c.service, c.invokeId);
        notify(key);
    });

    dev.on('lifeSafetyOperation', c => {
        const { operation, targetObjectId: t } = c.payload;
        calls.push(`LSO ${operation} ${t.type}:${t.instance} from ${c.payload.requestingSource}/${c.payload.processId}`);
        if (operation === 4) {
            for (const [k, o] of objects) {
                if ((t.type === OT.DEVICE || k === `${t.type}:${t.instance}`) && (o.pv === 2 || o.pv === 3)) {
                    o.pv = 0;
                    o.flags = 0;
                    notify(k);
                }
            }
        }
        dev.simpleAckResponse(c.header.sender, c.service, c.invokeId);
    });

    return {
        dev,
        calls,
        objects,
        /** Change an object like the real panel would (alarm, fault ...) and send COV. */
        set(type, instance, changes) {
            const k = `${type}:${instance}`;
            Object.assign(objects.get(k), changes);
            notify(k);
        },
        close: () => dev.close(),
    };
}

module.exports = { fakePanel };
