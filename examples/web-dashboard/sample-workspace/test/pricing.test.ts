import assert from 'node:assert/strict';
import test from 'node:test';
import { quotedPrice } from '../src/pricing.ts';

const tent = { sku: 'TENT-2', location: 'east-dock', onHand: 12, reserved: 2, category: 'camping' } as const;

test('camping orders receive the 15% spring discount', () => {
  assert.equal(quotedPrice(tent, 100, 2), 170);
});
test('kitchen items use the full unit price', () => {
  assert.equal(quotedPrice({ ...tent, category: 'kitchen' }, 100, 2), 200);
});
test('orders cannot exceed available stock', () => {
  assert.throws(() => quotedPrice(tent, 100, 11), /cannot be fulfilled/);
});
test('negative quantities must be rejected', () => {
  assert.throws(() => quotedPrice(tent, 100, -2), /quantity/i);
});
