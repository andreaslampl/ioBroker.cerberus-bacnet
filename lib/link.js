'use strict';

/*
 * BACnet/IP link: our own BACnet device (instance = the client ID the panel expects, e.g. 10)
 * plus the client services we need towards the panel.
 *
 * The panel only accepts commands from the configured BACnet client device, so we answer
 * Who-Is with I-Am and ReadProperty requests on our device object like a real device would.
 */

const { EventEmitter } = require('node:events');
const Bacnet = require('@bacnet-js/client');
const npdu = require('@bacnet-js/client/dist/lib/npdu');
const apdu = require('@bacnet-js/client/dist/lib/apdu');
const { LifeSafetyOperation } = require('@bacnet-js/client/dist/lib/services');

const BacnetClient = Bacnet.default;
const P = Bacnet.PropertyIdentifier;
const T = Bacnet.ApplicationTag;

class BacnetLink extends EventEmitter {
    /**
     * @param {object} options
     * @param {number} options.deviceId our device instance (the panel's "BACnet client device ID")
     * @param {number} [options.port] local UDP port (47808 = standard)
     * @param {string} [options.bind] local IP to bind to (default all)
     * @param {number} [options.timeout] APDU timeout in ms
     */
    constructor({ deviceId, port = 47808, bind, timeout = 6000, log }) {
        super();
        this.deviceId = deviceId;
        this.port = port;
        this.log = log;
        this.client = new BacnetClient({ port, interface: bind || undefined, apduTimeout: timeout, reuseAddr: true });
        this.client.on('error', err => this.emit('error', err));
        this.client.on('whoIs', c => this._whoIs(c));
        this.client.on('readProperty', c => this._readProperty(c));
        this.client.on('readPropertyMultiple', c => this._readPropertyMultiple(c));
        this.client.on('covNotifyUnconfirmed', c => this.emit('cov', c.payload));
        this.client.on('covNotify', c => {
            this._ack(c);
            this.emit('cov', c.payload);
        });
        this.client.on('eventNotify', c => {
            if (c.invokeId !== undefined && c.header && c.header.sender) {
                this._ack(c);
            }
            this.emit('event', c.payload);
        });
        this.client.on('timeSync', () => {});
        this.client.on('timeSyncUTC', () => {});
    }

    close() {
        this.client.close();
    }

    _ack(c) {
        try {
            this.client.simpleAckResponse(c.header.sender, c.service, c.invokeId);
        } catch (err) {
            this.log.debug(`BACnet ack: ${err.message}`);
        }
    }

    _whoIs(c) {
        const { lowLimit, highLimit } = c.payload || {};
        if (lowLimit !== undefined && highLimit !== undefined && (this.deviceId < lowLimit || this.deviceId > highLimit)) {
            return;
        }
        this.client.iAmResponse(c.header.sender, this.deviceId, Bacnet.Segmentation.NO_SEGMENTATION, 0);
    }

    /** Properties of our own device object (what a panel may ask a client device for). */
    _deviceProperty(id) {
        const dev = { type: Bacnet.ObjectType.DEVICE, instance: this.deviceId };
        switch (id) {
            case P.OBJECT_IDENTIFIER:
                return [{ type: T.OBJECTIDENTIFIER, value: dev }];
            case P.OBJECT_NAME:
                return [{ type: T.CHARACTER_STRING, value: `ioBroker ${this.deviceId}` }];
            case P.OBJECT_TYPE:
                return [{ type: T.ENUMERATED, value: Bacnet.ObjectType.DEVICE }];
            case P.SYSTEM_STATUS:
                return [{ type: T.ENUMERATED, value: 0 }]; // operational
            case P.VENDOR_NAME:
                return [{ type: T.CHARACTER_STRING, value: 'ioBroker' }];
            case P.VENDOR_IDENTIFIER:
                return [{ type: T.UNSIGNED_INTEGER, value: 0 }];
            case P.MODEL_NAME:
                return [{ type: T.CHARACTER_STRING, value: 'ioBroker.cerberus-bacnet' }];
            case P.FIRMWARE_REVISION:
            case P.APPLICATION_SOFTWARE_VERSION:
                return [{ type: T.CHARACTER_STRING, value: require('../package.json').version }];
            case P.PROTOCOL_VERSION:
                return [{ type: T.UNSIGNED_INTEGER, value: 1 }];
            case P.PROTOCOL_REVISION:
                return [{ type: T.UNSIGNED_INTEGER, value: 14 }];
            case P.MAX_APDU_LENGTH_ACCEPTED:
                return [{ type: T.UNSIGNED_INTEGER, value: 1476 }];
            case P.SEGMENTATION_SUPPORTED:
                return [{ type: T.ENUMERATED, value: Bacnet.Segmentation.NO_SEGMENTATION }];
            case P.APDU_TIMEOUT:
                return [{ type: T.UNSIGNED_INTEGER, value: 6000 }];
            case P.NUMBER_OF_APDU_RETRIES:
                return [{ type: T.UNSIGNED_INTEGER, value: 3 }];
            case P.DATABASE_REVISION:
                return [{ type: T.UNSIGNED_INTEGER, value: 0 }];
            case P.OBJECT_LIST:
                return [{ type: T.OBJECTIDENTIFIER, value: dev }];
            case P.DESCRIPTION:
            case P.LOCATION:
                return [{ type: T.CHARACTER_STRING, value: '' }];
            default:
                return null;
        }
    }

    _isUs(objectId) {
        return objectId && objectId.type === Bacnet.ObjectType.DEVICE && (objectId.instance === this.deviceId || objectId.instance === 0x3fffff);
    }

    _readProperty(c) {
        const { objectId, property } = c.payload;
        const value = this._isUs(objectId) ? this._deviceProperty(property.id) : null;
        if (!value) {
            this.client.errorResponse(c.header.sender, c.service, c.invokeId, Bacnet.ErrorClass.PROPERTY, Bacnet.ErrorCode.UNKNOWN_PROPERTY);
            return;
        }
        const own = { type: Bacnet.ObjectType.DEVICE, instance: this.deviceId };
        this.client.readPropertyResponse(c.header.sender, c.invokeId, own, property, value);
    }

    _readPropertyMultiple(c) {
        const out = [];
        for (const spec of c.payload.properties) {
            if (!this._isUs(spec.objectId)) {
                this.client.errorResponse(c.header.sender, c.service, c.invokeId, Bacnet.ErrorClass.OBJECT, Bacnet.ErrorCode.UNKNOWN_OBJECT);
                return;
            }
            const ids =
                spec.properties.length === 1 && spec.properties[0].id === P.ALL
                    ? [P.OBJECT_IDENTIFIER, P.OBJECT_NAME, P.OBJECT_TYPE, P.SYSTEM_STATUS, P.VENDOR_NAME, P.VENDOR_IDENTIFIER, P.MODEL_NAME, P.PROTOCOL_VERSION, P.PROTOCOL_REVISION]
                    : spec.properties.map(p => p.id);
            out.push({
                objectId: { type: Bacnet.ObjectType.DEVICE, instance: this.deviceId },
                values: ids.map(id => ({
                    property: { id, index: 0xffffffff },
                    value: this._deviceProperty(id) || [{ value: { type: 'BacnetError', errorClass: Bacnet.ErrorClass.PROPERTY, errorCode: Bacnet.ErrorCode.UNKNOWN_PROPERTY } }],
                })),
            });
        }
        this.client.readPropertyMultipleResponse(c.header.sender, c.invokeId, out);
    }

    // ---- client services towards the panel ----

    async read(address, objectId, propertyId, arrayIndex) {
        const res = await this.client.readProperty({ address }, objectId, propertyId, arrayIndex === undefined ? {} : { arrayIndex });
        return res.values;
    }

    /** @returns {Promise<Array<{objectId: object, values: Array<{id: number, value: any[]}>}>>} */
    async readMultiple(address, specs) {
        const res = await this.client.readPropertyMultiple(
            { address },
            specs.map(s => ({ objectId: s.objectId, properties: s.properties.map(id => ({ id, index: 0xffffffff })) })),
        );
        return res.values;
    }

    async write(address, objectId, propertyId, values, priority) {
        await this.client.writeProperty({ address }, objectId, propertyId, values, priority ? { priority } : {});
    }

    async subscribe(address, objectId, processId, lifetime) {
        await this.client.subscribeCov({ address }, objectId, processId, false, false, lifetime);
    }

    /** LifeSafetyOperation (reset, silence ...) - not wrapped by the library, encoded like its other services. */
    async lifeSafetyOperation(address, operation, objectId, source = 'ioBroker') {
        const c = this.client;
        const receiver = { address };
        const invokeId = c._getInvokeId();
        const buffer = c._getApduBuffer(receiver);
        npdu.encode(buffer, Bacnet.NpduControlPriority.NORMAL_MESSAGE | Bacnet.NpduControlBit.EXPECTING_REPLY, receiver);
        apdu.encodeConfirmedServiceRequest(
            buffer,
            Bacnet.PduType.CONFIRMED_REQUEST,
            Bacnet.ConfirmedServiceChoice.LIFE_SAFETY_OPERATION,
            Bacnet.MaxSegmentsAccepted.SEGMENTS_0,
            Bacnet.MaxApduLengthAccepted.OCTETS_1476,
            invokeId,
            0,
            0,
        );
        LifeSafetyOperation.encode(buffer, this.deviceId, source, operation, objectId);
        c.sendBvlc(receiver, buffer);
        await c._requestManager.add(invokeId);
    }
}

module.exports = { BacnetLink, Bacnet };
