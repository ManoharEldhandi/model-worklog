import type { InventoryItem } from './inventory.js';

const SPRING_CAMPING_DISCOUNT = 0.15;

export function quotedPrice(item: InventoryItem, unitPrice: number, requestedQuantity: number): number {
	const available = Math.max(0, item.onHand - item.reserved);
	if (requestedQuantity > available) {
		throw new Error('Requested quantity cannot be fulfilled.');
	}
	const discount = item.category === 'camping' ? SPRING_CAMPING_DISCOUNT : 0;
	return unitPrice * requestedQuantity * (1 - discount);
}