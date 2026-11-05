import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeInventory } from '../src/inventory.ts';

const item = { sku: 'LAMP-1', location: 'river-store', onHand: 8, reserved: 4, category: 'camping' } as const;

test('reserved stock is excluded and low stock triggers restocking', () => {
  assert.deepEqual(summarizeInventory(item), { available: 4, needsRestock: true });
});
test('over-reservation never produces negative availability', () => {
  assert.deepEqual(summarizeInventory({ ...item, reserved: 12 }), { available: 0, needsRestock: true });
});
test('five available items do not need restocking', () => {
  assert.equal(summarizeInventory({ ...item, reserved: 3 }).needsRestock, false);
});
