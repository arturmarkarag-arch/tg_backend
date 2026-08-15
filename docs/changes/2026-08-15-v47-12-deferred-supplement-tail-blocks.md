# V47.12 — deferred supplements, tail block deletion, restrained media cards

## Supplement
- Staff may select/confirm a supplement route while the group's ordinary ordering window is still open.
- No `SupplementOffer` is exposed to sellers in parallel with ordinary ordering.
- The receipt stays `supplementStatus=pending`; the existing minute scheduler retries and opens the offer after ordinary ordering closes.
- Seller runtime gate still hides/rejects supplements whenever ordinary ordering is open.

## Blocks
- Only the highest-numbered block may be deleted.
- It must have an empty stored `productIds` sequence.
- Deletion and creation share `blocks:sequence` lock.
- Counter rewinds to the new tail after deletion, preserving contiguous block numbers.

## Client UX
- Reduced product/photo rounding and switched critical thumbnails to `object-contain` to avoid clipping edge annotations.
- Removed product-list `keepPreviousData` and reset `ProductImage` source in `useLayoutEffect` to prevent a stale photo from flashing during query/product transitions.
- Full-photo preparation shows ordinary-session state as a warning; confirmation remains allowed because offer opening is deferred server-side.
