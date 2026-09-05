BaseLinker compact worker payload — manual server patch
Date: 2026-09-05

Apply on top of the latest BaseLinker real-server-pagination + problems-to-deferred server patches.

What changed:
- /api/baselinker/orders now exposes a small worker DTO instead of raw BaseLinker order objects.
- Cached order rows are stored compactly on future refreshes; old rows are projected compactly at read time immediately.
- Customer/contact/invoice/payment/commission/transaction/address data is not returned by the worker list endpoint.
- Product catalog entries contain state + the first image only; full descriptions, prices, stock, dimensions, tags, media and product blobs are not kept in the BaseLinker product cache response.
- getOrders no longer requests optional custom fields / commissions / connect / discount expansions.
- getInventoryProductsData no longer requests channel media expansion.
- Picking public/socket state no longer returns Mongo history, fingerprints, packed/sent audit blobs or per-item actor metadata.
- Journal socket order/catalog patches use the same compact DTO.
- Critical claim/pack reconciliation still re-reads current BaseLinker truth server-side and is unchanged.

No client files are required for this patch: existing client shape is preserved for the fields it actually uses (including catalog.images as a one-item array).
