# 2026-08-15 — V44 shift-board history thumbnail

`GET /api/picking/shift-board` now includes `imageUrl` on each `pickingHistory` row. The value is read from the same warehouse `Product.imageUrls[0]` / `localImageUrl` source used by picking cards. No new business state or write path was introduced.
