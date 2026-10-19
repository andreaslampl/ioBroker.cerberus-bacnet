'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { Bacnet } = require('../lib/link');
const { fakePanel } = require('./fake-panel');

const OT = Bacnet.ObjectType;

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.warnings = [];
        this.log = { debug() {}, info() {}, warn: m => this.warnings.push(m), error: m => this.warnings.push(m) };
    }
    async setState(id, val, ack) {
        this.states[id] = { val, ack };
    }
    async extendObject(id, obj) {
        this.objects[id] = obj;
    }
    async getChannelsOfAsync() {
        return Object.keys(this.objects)
            .filter(id => /^objects\.[^.]+$/.test(id) && this.objects[id].type === 'channel')
            .map(id => ({ _id: `${this.namespace}.${id}` }));
    }
    async delObjectAsync(id) {
        delete this.objects[id];
    }
    subscribeStates() {}
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    return origLoad.call(this, request, ...rest);
};

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

async function start(t, allowControl) {
    const port = 49000 + Math.floor(Math.random() * 400) * 2;
    const fake = fakePanel({ port });
    const adapter = require('../main.js')({
        // pollInterval in s: long on purpose, changes must arrive by COV
        config: { host: `127.0.0.1:${port}`, deviceId: 1, clientId: 10, localPort: port + 1, bind: '127.0.0.1', pollInterval: 300, timeout: 2, allowControl, priority: 8 },
    });
    adapter.objects['objects.point_99'] = { type: 'channel' }; // left over from an old configuration
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true && s['summary.alarm']);
    await until(() => fake.calls.includes('SUB 3:1')); // all COV subscriptions done
    t.after(async () => {
        await new Promise(resolve => adapter.emit('unload', resolve));
        fake.close();
    });
    return { adapter, fake, s, ns: adapter.namespace };
}

test('adapter (read only): objects, summary, alarm by COV, commands refused', async t => {
    const { adapter, fake, s, ns } = await start(t, false);
    assert.equal(s['info.panel'].val, 'FC2040 / FC2040 / 80.6.56');
    assert.equal(adapter.objects['objects.point_1'].common.name, 'Melder Wohnraum');
    assert.equal(adapter.objects['objects.point_1.mode'].common.write, false);
    assert.equal(adapter.objects['objects.point_1.reset'], undefined);
    assert.equal(adapter.objects['objects.point_99'], undefined);
    assert.equal(s['objects.point_1.state'].val, 'Ruhe');
    assert.equal(s['objects.bo_1.state'].val, 'Aus');
    assert.equal(s['summary.alarm'].val, false);

    fake.set(OT.LIFE_SAFETY_POINT, 2, { pv: 2, flags: 1 });
    await until(() => s['summary.alarm'].val === true);
    assert.equal(s['summary.alarmList'].val, 'Melder Flur');
    assert.equal(s['objects.point_2.alarm'].val, true);
    assert.equal(s['objects.point_2.state'].val, 'Alarm');
    assert.equal(s['summary.lastChange'].val, 'Melder Flur: Alarm');

    fake.set(OT.LIFE_SAFETY_POINT, 1, { pv: 3, flags: 2 });
    await until(() => s['summary.fault'].val === true);
    assert.equal(s['summary.faultList'].val, 'Melder Wohnraum');

    await adapter.onStateChange(`${ns}.panel.reset`, { val: true, ack: false });
    assert.match(adapter.warnings.join('\n'), /Commands are switched off/);
    assert.ok(!fake.calls.some(c => c.startsWith('LSO')));
});

test('adapter (commands allowed): disable a detector, reset, switch an output', async t => {
    const { adapter, fake, s, ns } = await start(t, true);
    assert.equal(adapter.objects['objects.point_1.mode'].common.write, true);
    assert.deepEqual(adapter.objects['objects.point_1.mode'].common.states, { 1: 'Ein', 0: 'Aus' });

    await adapter.onStateChange(`${ns}.objects.point_1.mode`, { val: 0, ack: false });
    assert.deepEqual(s['objects.point_1.mode'], { val: 0, ack: true });
    assert.equal(s['objects.point_1.disabled'].val, true);
    await until(() => s['summary.disabled'].val === true);
    assert.equal(s['summary.disabledList'].val, 'Melder Wohnraum');

    fake.set(OT.LIFE_SAFETY_POINT, 2, { pv: 2 });
    await until(() => s['summary.alarm'].val === true);
    await adapter.onStateChange(`${ns}.panel.reset`, { val: true, ack: false });
    assert.ok(fake.calls.includes('LSO 4 8:1 from ioBroker/10'));
    await until(() => s['summary.alarm'].val === false);
    assert.deepEqual(s['panel.reset'], { val: false, ack: true });

    await adapter.onStateChange(`${ns}.objects.bo_1.value`, { val: true, ack: false });
    assert.ok(fake.calls.includes('WP 4:1.85=1@8'));
    assert.deepEqual(s['objects.bo_1.value'], { val: true, ack: true });

    // refused by the panel: real value written back, no crash
    await adapter.onStateChange(`${ns}.objects.point_1.mode`, { val: 2, ack: false });
    assert.deepEqual(s['objects.point_1.mode'], { val: 0, ack: true });
    assert.match(adapter.warnings.join('\n'), /not accepted/);
});

test('adapter: panel extended -> new objects appear without restart', async t => {
    const { adapter, fake, s } = await start(t, false);
    assert.equal(adapter.objects['objects.point_3'], undefined);
    fake.extend(OT.LIFE_SAFETY_POINT, 3, { name: 'P3', description: 'Melder Keller', pv: 0, mode: 1, accepted: [1, 0], flags: 0 });
    await adapter.panel.poll();
    await until(() => s['objects.point_3.name'] && s['objects.point_3.name'].val === 'Melder Keller');
    assert.equal(adapter.objects['objects.point_3'].common.name, 'Melder Keller');
    fake.set(OT.LIFE_SAFETY_POINT, 3, { pv: 2 });
    await until(() => s['summary.alarmList'].val === 'Melder Keller');
});
