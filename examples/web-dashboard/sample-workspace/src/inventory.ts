export interface InventoryItem {
	readonly sku: string;
	readonly location: 'east-dock' | 'river-store';
	readonly onHand: number;
	readonly reserved: number;
	readonly category: 'camping' | 'kitchen' | 'safety';
}

export interface InventorySummary {
	readonly available: number;
	readonly needsRestock: boolean;
}

export function summarizeInventory(item: InventoryItem): InventorySummary {
	const available = Math.max(0, item.onHand - item.reserved);
	return { available, needsRestock: available < 5 };
}