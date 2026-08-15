# V46 — shop detail restored inside worker picking history

The V45 paginated worker history kept task counts but accidentally dropped the most useful shop-level context.

V46 keeps the V45 structure (workers remain the main list; expand one worker; 25 tasks at a time; «Показати ще +») and restores every shop of every task.

For each task the API now returns the shop name, frozen box number, quantity, current packed state, packed author and `markedByWorker` for the expanded worker.

The client shows three visually distinct states:
- green — this worker marked the shop;
- amber — another worker marked the shop (author shown when available);
- gray — the shop is still not marked.

History remains scoped to the current ordering session and paginated by worker.
