import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYERS, PORTS, SLOTS, portsOf, slotInfo, slotsOf } from '../src/index.ts';

test('every slot belongs to exactly one layer, and every layer lists its slots', () => {
  assert.equal(LAYERS.length, 11);
  assert.equal(SLOTS.length, 22);
  for (const { slot, layer } of SLOTS) {
    const owners = LAYERS.filter((l) => l.slots.includes(slot)).map((l) => l.layer);
    assert.deepEqual(owners, [layer], `slot ${slot}`);
  }
  for (const l of LAYERS) {
    assert.ok(l.slots.length >= 1, `layer ${l.layer} has no slot`);
    assert.equal(new Set(l.slots).size, l.slots.length, `layer ${l.layer} lists a slot twice`);
    for (const slot of l.slots) assert.equal(slotInfo(slot)?.layer, l.layer, `layer ${l.layer} lists ${slot}`);
    assert.deepEqual(slotsOf(l.layer).map((s) => s.slot), [...l.slots]);
  }
  assert.equal(LAYERS.reduce((n, l) => n + l.slots.length, 0), SLOTS.length);
});

test('every port is filled by exactly one slot, in the layer the port belongs to', () => {
  assert.equal(new Set(SLOTS.map((s) => s.slot)).size, SLOTS.length);
  for (const port of Object.values(PORTS)) {
    const slots = SLOTS.filter((s) => s.port === port.port);
    assert.equal(slots.length, 1, `${port.port} is filled by ${slots.map((s) => s.slot).join(', ') || 'no slot'}`);
    assert.equal(slots[0]!.layer, port.layer);
  }
  for (const l of LAYERS) {
    assert.deepEqual(slotsOf(l.layer).map((s) => s.port).sort(), portsOf(l.layer).map((p) => p.port).sort(), `ports of ${l.layer}`);
  }
});
