# Harbor Inventory

Harbor Inventory is a small TypeScript service that tracks stock for two
warehouse locations: `east-dock` and `river-store`. It applies seasonal
discounts only when an item is in stock and the requested quantity can be
fulfilled.

## Current Focus

- The spring promotion gives 15% off camping equipment.
- Restock alerts are raised when fewer than 5 items remain.
- The inventory service must never return a negative available quantity.

The dashboard runs Codex in a temporary copy of this folder. You can ask it to
read the code, run tests, or make changes. The checked-in files stay available
for the next demo; restarting the dashboard creates a fresh copy.

Run `npm test` with Node 22.13 or later. No packages need installing. Seven tests
cover inventory and pricing. One intentionally fails: a negative quantity
currently produces a negative quote instead of being rejected.

Try these in workspace chat:

1. "Read the inventory and pricing code, run npm test, and explain what fails."
2. "Fix the negative quantity bug and rerun the tests."

Then switch to **Ask logs** and ask "Which test failed and why?", "What changed?",
or "Did the tests pass after the fix?" Select **All retained traces** to compare
both tasks. Log answers use the captured activity, rather than rereading code.
