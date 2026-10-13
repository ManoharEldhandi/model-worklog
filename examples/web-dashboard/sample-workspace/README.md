# Harbor Inventory

Harbor Inventory is a small TypeScript service that tracks stock for two
warehouse locations: `east-dock` and `river-store`. It applies seasonal
discounts only when an item is in stock and the requested quantity can be
fulfilled.

## Current Focus

- The spring promotion gives 15% off camping equipment.
- Restock alerts are raised when fewer than 5 items remain.
- The inventory service must never return a negative available quantity.

The dashboard demo uses this workspace for read-only Copilot reviews. Ask it to
summarize the service, explain the discount rule, or identify the restock risk.