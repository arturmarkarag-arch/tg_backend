# V47.11 — decouple Receipt completion from product publication

For current regular staged receipts (`routingVersion >= 1` on every row):

- completing the Receipt closes the physical receiving document only;
- receipt completion requires the rows to have photo + received quantity;
- it no longer requires price/package/route/item confirmation;
- receipt completion does not itself create Product/ShopProduct artifacts;
- later per-item confirmation remains the publication boundary and works after Receipt completion.

Legacy routingVersion=0 and whole-receipt supplement flows retain the old commit path.
