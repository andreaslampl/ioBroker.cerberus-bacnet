'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BacnetLink, Bacnet } = require('../lib/link');
const { Panel } = require('../lib/panel');
const { fakePanel } = require('./fake-panel');

const OT = Bacnet.ObjectType;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let nextPort = 46000 + Math.floor(Math.random() * 400) * 4;

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

async function setup(t, fakeOptions = {}) {
    const port = nextPort;
    nextPort += 2;
    const fake = fakePanel({ port, ...fakeOptions });
    const link = new BacnetLink({ deviceId: 10, port: port + 1, bind: '127.0.0.1', timeout: 1500, log: quiet });
    const panel = new Panel({ link, address: `127.0.0.1:${port}`, deviceId: 1, log: quiet, pollInterval: 100000 });
    const changes = [];
    panel.on('change', o => changes.push(`${o.key}=${o.presentValue}`));
    t.after(() => {
        panel.stop();
        link.close();
        fake.close();
    });
    await new Promise(r => setTimeout(r, 100));
    await panel.start();
    return { fake, link, panel, changes };
}

test('reads the panel: objects, names, states, COV subscriptions', async t => {
    const { fake, panel } = await setup(t);
    assert.equal(panel.online, true);
    assert.equal(panel.info.model, 'FC2040');
    assert.deepEqual([...panel.objects.keys()].sort(), ['bi_1', 'bo_1', 'point_1', 'point_2', 'zone_1']);
    const p1 = panel.objects.get('point_1');
    assert.equal(p1.description, 'Melder Wohnraum');
    assert.equal(p1.lifeSafety, true);
    assert.deepEqual(p1.acceptedModes, [1, 0]);
    assert.equal(p1.mode, 1);
    assert.equal(p1.disabled, false);
    assert.equal(panel.objects.get('bo_1').activeText, 'Ein');
    assert.equal(panel.info.objectTypes[OT.NOTIFICATION_CLASS], 1);
    assert.ok(fake.calls.includes('SUB 21:1'));
});

test('alarm, fault and disablement arrive by COV', async t => {
    const { fake, panel, changes } = await setup(t);
    fake.set(OT.LIFE_SAFETY_POINT, 2, { pv: 2, flags: 1 });
    await until(() => changes.includes('point_2=2'));
    assert.equal(panel.objects.get('point_2').statusFlags.inAlarm, true);
    fake.set(OT.LIFE_SAFETY_POINT, 1, { mode: 0 });
    await until(() => panel.objects.get('point_1').disabled);
});

test('commands: mode, reset, silence, outputs; refused mode', async t => {
    const { fake, panel } = await setup(t);
    await panel.setMode('point_1', 0);
    assert.equal(panel.objects.get('point_1').mode, 0);
    assert.equal(panel.objects.get('point_1').disabled, true);
    await assert.rejects(panel.setMode('point_1', 2), /not accepted/);

    fake.set(OT.LIFE_SAFETY_POINT, 2, { pv: 2 });
    await until(() => panel.objects.get('point_2').presentValue === 2);
    await panel.operation(null, 4); // reset the whole panel
    assert.ok(fake.calls.some(c => c === 'LSO 4 8:1 from ioBroker/10'));
    await until(() => panel.objects.get('point_2').presentValue === 0);
    await panel.operation('zone_1', 1);
    assert.ok(fake.calls.includes('LSO 1 22:1 from ioBroker/10'));

    await panel.writeValue('bo_1', true, 8);
    assert.ok(fake.calls.includes('WP 4:1.85=1@8'));
    assert.equal(panel.objects.get('bo_1').presentValue, 1);
    await panel.writeValue('bo_1', null, 8);
    assert.ok(fake.calls.includes('WP 4:1.85=null@8'));
    await assert.rejects(panel.writeValue('bi_1', true, 8), /cannot be switched/);
});

test('panel without ReadPropertyMultiple and with a long object list', async t => {
    const { fake, panel } = await setup(t, { noRpm: true, shortList: true });
    assert.equal(panel.rpm, false);
    assert.equal(panel.objects.size, 5);
    assert.ok(fake.calls.includes('RP 8:1.76')); // object list by index
    assert.equal(panel.objects.get('zone_1').description, 'Gebäude');
    fake.objects.get('21:1').pv = 3;
    await panel.poll();
    assert.equal(panel.objects.get('point_1').presentValue, 3);
});

test('our own device answers Who-Is and ReadProperty like a BACnet client device', async t => {
    const { link } = await setup(t);
    const probe = new (Bacnet.default)({ port: nextPort++, interface: '127.0.0.1', apduTimeout: 1500 });
    t.after(() => probe.close());
    const target = { address: `127.0.0.1:${link.port}` };
    const name = await probe.readProperty(target, { type: OT.DEVICE, instance: 10 }, Bacnet.PropertyIdentifier.OBJECT_NAME);
    assert.equal(name.values[0].value, 'ioBroker 10');
    const iams = [];
    probe.on('iAm', c => iams.push(c.payload.deviceId));
    probe.whoIs(target);
    await until(() => iams.includes(10));
});

test('panel offline: no crash, comes online later', async t => {
    const port = nextPort;
    nextPort += 2;
    const link = new BacnetLink({ deviceId: 10, port: port + 1, bind: '127.0.0.1', timeout: 500, log: quiet });
    const panel = new Panel({ link, address: `127.0.0.1:${port}`, deviceId: 1, log: quiet, pollInterval: 300 });
    const online = [];
    panel.on('online', v => online.push(v));
    t.after(() => {
        panel.stop();
        link.close();
    });
    await panel.start();
    assert.equal(panel.online, false);
    const fake = fakePanel({ port });
    t.after(() => fake.close());
    await until(() => panel.online, 8000);
    assert.deepEqual(online, [true]);
});

test('panel denies a client that did not announce itself; readable hint in the log', async t => {
    const { describe } = require('../lib/panel');
    const port = nextPort;
    nextPort += 2;
    const fake = fakePanel({ port });
    const link = new BacnetLink({ deviceId: 11, port: port + 1, bind: '127.0.0.1', timeout: 1500, log: quiet }); // wrong client ID
    const warnings = [];
    const panel = new Panel({ link, address: `127.0.0.1:${port}`, deviceId: 1, log: { ...quiet, warn: m => warnings.push(m) }, pollInterval: 100000 });
    t.after(() => {
        panel.stop();
        link.close();
        fake.close();
    });
    await panel.start();
    assert.equal(panel.online, false);
    assert.ok(fake.calls.includes('DENIED'));
    assert.equal(panel.rpm, true); // denied is not "RPM unsupported"
    assert.match(warnings.join('\n'), /refuses the request.*client ID/);
    assert.match(describe(new Error('ERR_TIMEOUT')), /no answer/);
});

test('diagnosis when denied: Who-Is answer of the panel is logged', async t => {
    const port = nextPort;
    nextPort += 2;
    const fake = fakePanel({ port });
    const link = new BacnetLink({ deviceId: 11, port: port + 1, bind: '127.0.0.1', timeout: 1500, log: quiet });
    const infos = [];
    const panel = new Panel({ link, address: `127.0.0.1:${port}`, deviceId: 1, log: { ...quiet, info: m => infos.push(m) }, pollInterval: 100000 });
    t.after(() => {
        panel.stop();
        link.close();
        fake.close();
    });
    await panel.start();
    assert.match(infos.join('\n'), /panel answers Who-Is as device 1/);
    assert.match(infos.join('\n'), /has not contacted us/);
});
