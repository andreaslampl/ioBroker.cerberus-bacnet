'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { arrange, parseName } = require('../lib/naming');

// Object name patterns as reported by a Cerberus PRO FC2040; customer texts invented.
const objects = [
    ['point_1881', 21, 'LP_SENSOR_AUTOMATIC_1/1_1/1881', 'Brand Bad'],
    ['point_1880', 21, 'LP_SOUNDER_BASE_1/1/1_1/1880', 'Sockel-Sounder'],
    ['point_1883', 21, 'LP_SENSOR_AUTOMATIC_1/2_1/1883', 'Brand Flur'],
    ['point_1882', 21, 'LP_SOUNDER_BASE_1/2/1_1/1882', 'Sockel-Sounder'],
    ['point_1916', 21, 'LP_OUTPUT_FIRE_1/1_1/1916', 'LP_OUTPUT_FIRE_1/1_1/1916'],
    ['zone_9', 22, 'LZ_AREA_FIRE_DETECTION_1_1/9', 'Gebäude'],
    ['zone_1196', 22, 'LZ_SECTION_1_1/1196', 'LZ_SECTION_1_1/1196'],
    ['zone_389', 22, 'LZ_CHANNEL_PHYS_1/1/2_1/389', 'Sirenen'],
    ['zone_4194234', 22, 'LZ_CHANNEL_PHYS_1/2/1/8/1_1/4194234', 'Sensor'],
    ['zone_4194236', 22, 'LZ_CHANNEL_PHYS_1/2/1/7/1_1/4194236', 'Sensor'],
    ['zone_4194235', 22, 'LZ_DEVICE_P2_EN_1/2/1/8_1/4194235', 'FDOOT271'],
    ['zone_4194289', 22, 'LZ_LINE_1/2/21_1/4194289', 'Stich 21'],
    ['zone_4194295', 22, 'LZ_LINE_1/3/21_1/4194295', 'Stich 21'],
    ['zone_1844', 22, 'LZ_BACNET_LINE_SUMMARY_1/2/1/1_1/1844', 'LZ_BACNET_LINE_SUMMARY_1/2/1/1_1/1844'],
    ['zone_1865', 22, 'LZ_CAUSE_GROUP_OTHER_0_1/1865', 'LZ_CAUSE_GROUP_OTHER_0_1/1865'],
    ['zone_16', 22, 'LZ_PMI_1_1/16', 'Bedienfeld'],
    ['zone_1285', 22, 'LZ_GROUP_COUNTER_1_1/1285', 'Alarmzähler'],
    ['msv_1266', 19, 'MV_BACNET_BLOCK_CMD_1/1_1/1266', 'Panel block commands'],
].map(([key, type, name, description]) => ({ key, type, name, description }));

test('object names are parsed into kind and address', () => {
    assert.deepEqual(parseName('LZ_DEVICE_P2_EN_1/2/1/8_1/4194235'), { kind: 'DEVICE_P2_EN', address: '1/2/1/8' });
    assert.deepEqual(parseName('LP_SENSOR_AUTOMATIC_1/2_1/1883'), { kind: 'SENSOR_AUTOMATIC', address: '1/2' });
    assert.equal(parseName('BO1'), null);
});

test('folders, readable and unique names', () => {
    const a = arrange(objects);
    const id = key => a.get(key).id;
    const name = key => a.get(key).name;
    assert.equal(id('point_1881'), 'melder.brand_bad');
    assert.equal(name('point_1882'), 'Sockel-Sounder Flur'); // named after the detector it sits on
    assert.equal(id('point_1880'), 'sounder.sockel_sounder_bad');
    assert.equal(id('zone_389'), 'ein_ausgaenge.sirenen');
    assert.equal(name('point_1916'), 'Ausgang 1/1');
    assert.equal(a.get('point_1916').category, 'steuerungen');
    assert.equal(id('zone_9'), 'bereiche.gebaeude');
    assert.equal(name('zone_1196'), 'Abschnitt 1');
    assert.equal(name('zone_4194234'), 'Sensor (1/2/1/8/1)'); // loop device channel -> hardware, address added
    assert.equal(a.get('zone_4194234').category, 'hardware');
    assert.equal(name('zone_4194289'), 'Stich 21 (1/2/21)');
    assert.equal(name('zone_4194295'), 'Stich 21 (1/3/21)');
    assert.equal(a.get('zone_1844').category, 'intern');
    assert.equal(a.get('zone_1865').category, 'intern');
    assert.equal(id('zone_16'), 'bedienung.bedienfeld');
    assert.equal(a.get('zone_1285').category, 'system');
    assert.equal(a.get('msv_1266').category, 'system');
    assert.equal(new Set([...a.values()].map(x => x.id)).size, objects.length);
});
