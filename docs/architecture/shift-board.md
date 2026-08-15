# Shift board («Зміна») — current UI contract

`GET /api/picking/shift-board?deliveryGroupId=...` returns the live roster and counters for the CURRENT OrderingSession only. The main board does not preload the full task history.

The UI keeps the warehouse worker roster as the primary list. Every worker row can be expanded with a chevron. Expansion calls:

`GET /api/picking/shift-board/worker-history?deliveryGroupId=...&workerTelegramId=...&limit=25&offset=0`

The endpoint is admin-only, current-session scoped, and returns at most 25 rows by default. A task belongs to the worker history if the worker completed it, currently owns its lock, or authored at least one packed checkbox. The response includes the product thumbnail and `hasMore`; the client loads another 25 rows with «Показати ще +».
Each returned task also contains its full shop list (`shops`) with frozen box number, shop name, packed author and `markedByWorker`, so the expanded worker row can show exactly which shops that worker marked and which they did not.

Historical OrderingSessions are deliberately excluded from this page. A new group session therefore starts with an empty worker task history without deleting old PickingTask records.
