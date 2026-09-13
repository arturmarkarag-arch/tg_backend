# Endpoint × role inventory — 2026-09-13

This is a complete inventory of runtime Express route declarations, discovered router mounts, and static surfaces.
A check mark means that the role passes the route-entry auth/role middleware. Resource ownership, shop/group/session
scope, one-time tokens, rate limits, feature flags, and request validation can still deny a request as noted.

Routes: **405** · anonymous: **18** · seller: **75** · warehouse: **200** · admin: **395**

| Endpoint | Anonymous | Seller | Warehouse | Admin | Source | Boundary note |
|---|:---:|:---:|:---:|:---:|---|---|
| `DELETE /api/admin/allegro-settings/accounts/:accountId` | — | — | — | ✓ | `routes/admin.js:54` | route-entry authorization |
| `DELETE /api/admin/cities/:id` | — | — | — | ✓ | `routes/admin.js:371` | route-entry authorization |
| `DELETE /api/admin/price-groups/:groupId` | — | — | — | ✓ | `routes/admin.js:709` | route-entry authorization |
| `DELETE /api/admin/telegram-groups/:groupId` | — | — | — | ✓ | `routes/admin.js:468` | route-entry authorization |
| `DELETE /api/admin/telegram-groups/:groupId/members/:telegramId` | — | — | — | ✓ | `routes/admin.js:743` | route-entry authorization |
| `DELETE /api/admin/telegram-member-tag-groups/:groupId` | — | — | — | ✓ | `routes/admin.js:516` | route-entry authorization |
| `DELETE /api/admin/telegram-support-admins/:username` | — | — | — | ✓ | `routes/admin.js:580` | route-entry authorization |
| `DELETE /api/blocks/:number` | — | — | ✓ | ✓ | `routes/blocks.js:395` | route-entry authorization |
| `DELETE /api/blocks/:number/products/:productId` | — | — | ✓ | ✓ | `routes/blocks.js:323` | route-entry authorization |
| `DELETE /api/delivery-groups/:id` | — | — | — | ✓ | `routes/deliveryGroups.js:478` | route-entry authorization |
| `DELETE /api/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1677` | route-entry authorization |
| `DELETE /api/products/orphan-photo` | — | — | ✓ | ✓ | `routes/products.js:384` | route-entry authorization |
| `DELETE /api/receipts/:id` | — | — | ✓ | ✓ | `routes/receipts.js:729` | route-entry authorization |
| `DELETE /api/receipts/:id/items/:itemId` | — | — | ✓ | ✓ | `routes/receipts.js:1559` | route-entry authorization |
| `DELETE /api/shop-products/:id` | — | — | ✓ | ✓ | `routes/shopProducts.js:515` | route-entry authorization |
| `DELETE /api/shop-transfer/my` | — | ✓ | — | — | `routes/shopTransfer.js:158` | route-entry authorization |
| `DELETE /api/shops/:id` | — | — | — | ✓ | `routes/shops.js:339` | route entry only; response projection may vary by role |
| `DELETE /api/supplement/:offerId/request` | — | ✓ | — | ✓ | `routes/supplement.js:281` | route-entry authorization |
| `DELETE /api/supplement/requests/:requestId` | — | ✓ | — | ✓ | `routes/supplement.js:259` | route-entry authorization |
| `DELETE /api/users/:telegramId` | — | — | — | ✓ | `routes/users.js:275` | route-entry authorization |
| `DELETE /api/v1/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1677` | route-entry authorization |
| `DELETE /api/v1/products/orphan-photo` | — | — | ✓ | ✓ | `routes/products.js:384` | route-entry authorization |
| `DELETE /api/v1/telegram/register-requests/:id` | — | — | — | ✓ | `routes/v1/telegram.js:910` | route-entry authorization |
| `DELETE /api/vision-search/logs` | — | — | — | ✓ | `routes/visionSearch.js:456` | route-entry authorization |
| `GET /api/admin/allegro-settings` | — | — | — | ✓ | `routes/admin.js:34` | route-entry authorization |
| `GET /api/admin/baselinker-settings` | — | — | — | ✓ | `routes/admin.js:59` | route-entry authorization |
| `GET /api/admin/baselinker-settings/accounts/:accountId/statuses` | — | — | — | ✓ | `routes/admin.js:155` | route-entry authorization |
| `GET /api/admin/cities` | — | — | — | ✓ | `routes/admin.js:331` | route-entry authorization |
| `GET /api/admin/egress-traffic` | — | — | — | ✓ | `routes/admin.js:808` | route-entry authorization |
| `GET /api/admin/openai-key` | — | — | — | ✓ | `routes/admin.js:415` | route-entry authorization |
| `GET /api/admin/openai/costs` | — | — | — | ✓ | `routes/admin.js:828` | route-entry authorization |
| `GET /api/admin/openai/models` | — | — | — | ✓ | `routes/admin.js:186` | route-entry authorization |
| `GET /api/admin/openai/settings` | — | — | — | ✓ | `routes/admin.js:192` | route-entry authorization |
| `GET /api/admin/openai/usage` | — | — | — | ✓ | `routes/admin.js:841` | route-entry authorization |
| `GET /api/admin/ordering-schedule` | — | — | — | ✓ | `routes/admin.js:292` | route-entry authorization |
| `GET /api/admin/price-groups` | — | — | — | ✓ | `routes/admin.js:683` | route-entry authorization |
| `GET /api/admin/supplement-settings` | — | — | — | ✓ | `routes/admin.js:315` | route-entry authorization |
| `GET /api/admin/telegram-delivery/events` | — | — | — | ✓ | `routes/admin.js:213` | route-entry authorization |
| `GET /api/admin/telegram-delivery/events/:eventKey` | — | — | — | ✓ | `routes/admin.js:223` | route-entry authorization |
| `GET /api/admin/telegram-groups` | — | — | — | ✓ | `routes/admin.js:442` | route-entry authorization |
| `GET /api/admin/telegram-groups/:groupId/members` | — | — | — | ✓ | `routes/admin.js:723` | route-entry authorization |
| `GET /api/admin/telegram-member-tag-groups` | — | — | — | ✓ | `routes/admin.js:482` | route-entry authorization |
| `GET /api/admin/telegram-member-tags` | — | — | — | ✓ | `routes/admin.js:529` | route-entry authorization |
| `GET /api/admin/telegram-new-products-group` | — | — | — | ✓ | `routes/admin.js:590` | route-entry authorization |
| `GET /api/admin/telegram-new-products-history` | — | — | — | ✓ | `routes/admin.js:663` | route-entry authorization |
| `GET /api/admin/telegram-support-admins` | — | — | — | ✓ | `routes/admin.js:549` | route-entry authorization |
| `GET /api/admin/vision-settings` | — | — | — | ✓ | `routes/admin.js:275` | route-entry authorization |
| `GET /api/allegro/accounts/:accountId/orders/:orderId` | — | — | — | ✓ | `routes/allegro.js:201` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/accounts/:accountId/orders/:orderId/picking` | — | — | — | ✓ | `routes/allegro.js:241` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/accounts/:accountId/orders/:orderId/shipment` | — | — | — | ✓ | `routes/allegro.js:209` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/accounts/:accountId/orders/:orderId/shipment/label` | — | — | — | ✓ | `routes/allegro.js:219` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/api-usage` | — | — | — | ✓ | `routes/allegro.js:129` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/errors` | — | — | — | ✓ | `routes/allegro.js:135` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/oauth/callback` | ✓ | ✓ | ✓ | ✓ | `routes/allegro.js:50` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/allegro/orders` | — | — | — | ✓ | `routes/allegro.js:188` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/picking/my-active` | — | — | — | ✓ | `routes/allegro.js:231` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/status` | — | — | — | ✓ | `routes/allegro.js:72` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/archive` | — | — | ✓ | ✓ | `routes/archive.js:23` | route-entry authorization |
| `GET /api/baselinker/accounts/:accountId/orders/:orderId` | — | — | — | ✓ | `routes/baseLinker.js:216` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/accounts/:accountId/orders/:orderId/packages` | — | — | — | ✓ | `routes/baseLinker.js:322` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/accounts/:accountId/orders/:orderId/packages/:packageId/details` | — | — | — | ✓ | `routes/baseLinker.js:323` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/accounts/:accountId/orders/:orderId/packages/:packageId/label` | — | — | — | ✓ | `routes/baseLinker.js:324` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/accounts/:accountId/orders/:orderId/picking` | — | — | — | ✓ | `routes/baseLinker.js:393` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/accounts/:accountId/orders/:orderId/shipment/label` | — | — | — | ✓ | `routes/baseLinker.js:320` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/api-usage` | — | — | — | ✓ | `routes/baseLinker.js:99` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/meta` | — | — | — | ✓ | `routes/baseLinker.js:117` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/orders` | — | — | — | ✓ | `routes/baseLinker.js:215` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/picking/my-active` | — | — | — | ✓ | `routes/baseLinker.js:388` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/print-agent/status` | — | — | — | ✓ | `routes/baseLinker.js:327` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/baselinker/status` | — | — | — | ✓ | `routes/baseLinker.js:77` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/blocks` | — | — | ✓ | ✓ | `routes/blocks.js:107` | route-entry authorization |
| `GET /api/blocks/:number` | — | — | ✓ | ✓ | `routes/blocks.js:248` | route-entry authorization |
| `GET /api/blocks/incoming/products` | — | — | ✓ | ✓ | `routes/blocks.js:204` | route-entry authorization |
| `GET /api/blocks/search/products` | — | — | ✓ | ✓ | `routes/blocks.js:232` | route-entry authorization |
| `GET /api/bot-status` | — | — | — | ✓ | `app.js:142` | route-entry authorization |
| `GET /api/commerce/catalog` | — | — | — | ✓ | `routes/commerce.js:214` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/catalog/:id` | — | — | — | ✓ | `routes/commerce.js:236` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/catalog/warehouse-products` | — | — | — | ✓ | `routes/commerce.js:220` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/categories` | — | — | — | ✓ | `routes/commerce.js:199` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/integrations` | — | — | — | ✓ | `routes/commerce.js:36` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/providers` | — | — | — | ✓ | `routes/commerce.js:42` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/delivery-groups` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:243` | route-entry authorization |
| `GET /api/delivery-groups/:groupId/shop-status` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:118` | route-entry authorization |
| `GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:136` | route-entry authorization |
| `GET /api/delivery-groups/ordering-status` | — | ✓ | ✓ | ✓ | `routes/deliveryGroups.js:49` | route-entry authorization |
| `GET /api/delivery-groups/session-summaries` | — | — | — | ✓ | `routes/deliveryGroups.js:147` | route-entry authorization |
| `GET /api/delivery-groups/summary` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:109` | route-entry authorization |
| `GET /api/gemini-status` | — | — | — | ✓ | `app.js:160` | route-entry authorization |
| `GET /api/health` | ✓ | ✓ | ✓ | ✓ | `app.js:130` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/maintenance` | ✓ | ✓ | ✓ | ✓ | `app.js:138` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/nav-badges` | — | ✓ | ✓ | ✓ | `routes/navBadges.js:91` | route-entry authorization |
| `GET /api/openai-status` | — | — | — | ✓ | `app.js:146` | route-entry authorization |
| `GET /api/picking/block-tasks` | — | — | ✓ | ✓ | `routes/picking.js:941` | route-entry authorization |
| `GET /api/picking/blocks-overview` | — | — | ✓ | ✓ | `routes/picking.js:1024` | route-entry authorization |
| `GET /api/picking/locked-tasks` | — | — | ✓ | ✓ | `routes/picking.js:1415` | route-entry authorization |
| `GET /api/picking/my-task` | — | — | ✓ | ✓ | `routes/picking.js:891` | route-entry authorization |
| `GET /api/picking/next-task` | — | — | ✓ | ✓ | `routes/picking.js:935` | route-entry authorization |
| `GET /api/picking/queue-stats` | — | — | ✓ | ✓ | `routes/picking.js:1069` | route-entry authorization |
| `GET /api/picking/schedule` | — | — | ✓ | ✓ | `routes/picking.js:286` | route-entry authorization |
| `GET /api/picking/session-closure` | — | — | ✓ | ✓ | `routes/picking.js:1468` | route-entry authorization |
| `GET /api/picking/session-snapshot` | — | — | ✓ | ✓ | `routes/picking.js:304` | route-entry authorization |
| `GET /api/picking/session-status` | — | ✓ | ✓ | ✓ | `routes/picking.js:263` | seller is additionally restricted to own authoritative delivery group |
| `GET /api/picking/shift-board` | — | — | — | ✓ | `routes/picking.js:1494` | route-entry authorization |
| `GET /api/picking/shift-board/seller-notifications` | — | — | — | ✓ | `routes/picking.js:1698` | route-entry authorization |
| `GET /api/picking/shift-board/worker-history` | — | — | — | ✓ | `routes/picking.js:1728` | route-entry authorization |
| `GET /api/print-agent/jobs/:jobId/payload` | — | — | — | — | `routes/baseLinkerPrintAgent.js:49` | Print Agent token, not a user role |
| `GET /api/product-feedback` | — | — | ✓ | ✓ | `routes/productFeedback.js:63` | route-entry authorization |
| `GET /api/products` | — | — | ✓ | ✓ | `routes/products.js:660` | route-entry authorization |
| `GET /api/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1234` | route-entry authorization |
| `GET /api/products/:id/position` | — | — | ✓ | ✓ | `routes/products.js:597` | route-entry authorization |
| `GET /api/products/:id/who-ordered` | — | — | ✓ | ✓ | `routes/products.js:1157` | route-entry authorization |
| `GET /api/products/catalog` | — | ✓ | ✓ | ✓ | `routes/products.js:515` | route-entry authorization |
| `GET /api/products/catalog/:id/position` | — | ✓ | ✓ | ✓ | `routes/products.js:556` | route-entry authorization |
| `GET /api/products/check` | — | — | ✓ | ✓ | `routes/products.js:821` | route-entry authorization |
| `GET /api/products/drafts` | — | — | ✓ | ✓ | `routes/products.js:463` | route-entry authorization |
| `GET /api/products/new-list` | — | ✓ | ✓ | ✓ | `routes/products.js:923` | route-entry authorization |
| `GET /api/products/pending` | — | — | ✓ | ✓ | `routes/products.js:852` | route-entry authorization |
| `GET /api/products/proxy-image` | — | — | ✓ | ✓ | `routes/products.js:1208` | route-entry authorization |
| `GET /api/products/upload-url` | — | — | ✓ | ✓ | `routes/products.js:303` | route-entry authorization |
| `GET /api/products/upload-url-pair` | — | — | ✓ | ✓ | `routes/products.js:332` | route-entry authorization |
| `GET /api/products/upload-url-public` | — | ✓ | ✓ | ✓ | `routes/products.js:404` | route-entry authorization |
| `GET /api/products/upload-url-triple` | — | — | ✓ | ✓ | `routes/products.js:362` | route-entry authorization |
| `GET /api/products/warehouse-stats` | — | — | ✓ | ✓ | `routes/products.js:192` | route-entry authorization |
| `GET /api/receipts` | — | — | ✓ | ✓ | `routes/receipts.js:229` | route-entry authorization |
| `GET /api/receipts/:id` | — | — | ✓ | ✓ | `routes/receipts.js:723` | route-entry authorization |
| `GET /api/receipts/:id/items` | — | — | ✓ | ✓ | `routes/receipts.js:1073` | route-entry authorization |
| `GET /api/receipts/:id/items/:itemId/telegram-new-product` | — | — | ✓ | ✓ | `routes/receipts.js:1470` | route-entry authorization |
| `GET /api/receipts/:id/items/:itemId/telegram-new-product/history` | — | — | ✓ | ✓ | `routes/receipts.js:1515` | route-entry authorization |
| `GET /api/receipts/:id/logs` | — | — | ✓ | ✓ | `routes/receipts.js:2820` | route-entry authorization |
| `GET /api/receipts/:id/supplement-targets` | — | — | ✓ | ✓ | `routes/receipts.js:2442` | route-entry authorization |
| `GET /api/receipts/items-gallery` | — | — | ✓ | ✓ | `routes/receipts.js:292` | route-entry authorization |
| `GET /api/receipts/product-context/:productId` | — | — | ✓ | ✓ | `routes/receipts.js:403` | route-entry authorization |
| `GET /api/receipts/supplement-batches/pending` | — | — | ✓ | ✓ | `routes/receipts.js:448` | route-entry authorization |
| `GET /api/search-products` | — | ✓ | ✓ | ✓ | `routes/searchProducts.js:85` | route-entry authorization |
| `GET /api/search-products/check` | — | ✓ | ✓ | ✓ | `routes/searchProducts.js:58` | route-entry authorization |
| `GET /api/search-products/images/:filename` | — | ✓ | ✓ | ✓ | `routes/searchProducts.js:51` | route-entry authorization |
| `GET /api/shop-products` | — | ✓ | ✓ | ✓ | `routes/shopProducts.js:95` | route-entry authorization |
| `GET /api/shop-products/:id` | — | ✓ | ✓ | ✓ | `routes/shopProducts.js:154` | route-entry authorization |
| `GET /api/shop-products/barcode/:code` | — | ✓ | ✓ | ✓ | `routes/shopProducts.js:141` | route-entry authorization |
| `GET /api/shop-transfer` | — | — | — | ✓ | `routes/shopTransfer.js:180` | route-entry authorization |
| `GET /api/shop-transfer/my` | — | ✓ | — | — | `routes/shopTransfer.js:170` | route-entry authorization |
| `GET /api/shops` | — | ✓ | ✓ | ✓ | `routes/shops.js:39` | route entry only; response projection may vary by role |
| `GET /api/shops/:id` | — | ✓ | ✓ | ✓ | `routes/shops.js:283` | route entry only; response projection may vary by role |
| `GET /api/shops/cities` | ✓ | ✓ | ✓ | ✓ | `routes/shops.js:220` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/shops/reference` | — | — | ✓ | ✓ | `routes/shops.js:273` | route entry only; response projection may vary by role |
| `GET /api/shops/registry` | ✓ | ✓ | ✓ | ✓ | `routes/shops.js:234` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/shops/without-seller` | — | — | ✓ | ✓ | `routes/shops.js:246` | route entry only; response projection may vary by role |
| `GET /api/supplement/admin/seller/:telegramId` | — | — | — | ✓ | `routes/supplement.js:344` | route-entry authorization |
| `GET /api/supplement/available` | — | ✓ | — | ✓ | `routes/supplement.js:156` | route-entry authorization |
| `GET /api/supplement/group/:deliveryGroupId` | — | — | ✓ | ✓ | `routes/supplement.js:420` | route-entry authorization |
| `GET /api/supplement/my` | — | ✓ | — | ✓ | `routes/supplement.js:293` | route-entry authorization |
| `GET /api/supplement/offers/:offerId` | — | — | ✓ | ✓ | `routes/supplement.js:580` | route-entry authorization |
| `GET /api/users` | — | — | — | ✓ | `routes/users.js:64` | route-entry authorization |
| `GET /api/users/:telegramId` | — | — | — | ✓ | `routes/users.js:111` | route-entry authorization |
| `GET /api/users/:telegramId/cleared-carts` | — | — | — | ✓ | `routes/users.js:119` | route-entry authorization |
| `GET /api/users/assignment-candidates` | — | — | — | ✓ | `routes/users.js:91` | route-entry authorization |
| `GET /api/v1/auth/config` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:105` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/v1/auth/me` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:221` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `GET /api/v1/orders` | — | ✓ | ✓ | ✓ | `routes/orders.js:486` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/:id` | — | ✓ | ✓ | ✓ | `routes/orders.js:699` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/conflicts` | — | — | ✓ | ✓ | `routes/orders.js:339` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/current-items` | — | ✓ | — | ✓ | `routes/orders.js:596` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/transit/active` | — | — | ✓ | ✓ | `routes/orders.js:648` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/products` | — | — | ✓ | ✓ | `routes/products.js:660` | route-entry authorization |
| `GET /api/v1/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1234` | route-entry authorization |
| `GET /api/v1/products/:id/position` | — | — | ✓ | ✓ | `routes/products.js:597` | route-entry authorization |
| `GET /api/v1/products/:id/who-ordered` | — | — | ✓ | ✓ | `routes/products.js:1157` | route-entry authorization |
| `GET /api/v1/products/catalog` | — | ✓ | ✓ | ✓ | `routes/products.js:515` | route-entry authorization |
| `GET /api/v1/products/catalog/:id/position` | — | ✓ | ✓ | ✓ | `routes/products.js:556` | route-entry authorization |
| `GET /api/v1/products/check` | — | — | ✓ | ✓ | `routes/products.js:821` | route-entry authorization |
| `GET /api/v1/products/drafts` | — | — | ✓ | ✓ | `routes/products.js:463` | route-entry authorization |
| `GET /api/v1/products/new-list` | — | ✓ | ✓ | ✓ | `routes/products.js:923` | route-entry authorization |
| `GET /api/v1/products/pending` | — | — | ✓ | ✓ | `routes/products.js:852` | route-entry authorization |
| `GET /api/v1/products/proxy-image` | — | — | ✓ | ✓ | `routes/products.js:1208` | route-entry authorization |
| `GET /api/v1/products/upload-url` | — | — | ✓ | ✓ | `routes/products.js:303` | route-entry authorization |
| `GET /api/v1/products/upload-url-pair` | — | — | ✓ | ✓ | `routes/products.js:332` | route-entry authorization |
| `GET /api/v1/products/upload-url-public` | — | ✓ | ✓ | ✓ | `routes/products.js:404` | route-entry authorization |
| `GET /api/v1/products/upload-url-triple` | — | — | ✓ | ✓ | `routes/products.js:362` | route-entry authorization |
| `GET /api/v1/products/warehouse-stats` | — | — | ✓ | ✓ | `routes/products.js:192` | route-entry authorization |
| `GET /api/v1/telegram/register-requests` | — | — | — | ✓ | `routes/v1/telegram.js:781` | route-entry authorization |
| `GET /api/vision-search/logs` | — | — | ✓ | ✓ | `routes/visionSearch.js:426` | route-entry authorization |
| `GET /api/vision-search/upload-url` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:54` | route-entry authorization |
| `GET /api/warehouse-test/health` | — | — | — | ✓ | `routes/warehouseTest.js:118` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/jobs` | — | — | — | ✓ | `routes/warehouseTest.js:1035` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/status/:jobId` | — | — | — | ✓ | `routes/warehouseTest.js:1028` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/suite/list` | — | — | — | ✓ | `routes/warehouseTest.js:1164` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/suite/status/:jobId` | — | — | — | ✓ | `routes/warehouseTest.js:1139` | admin and ENABLE_TEST_API outside production |
| `GET/HEAD /uploads/*` | — | — | ✓ | ✓ | `app.js:55` | authenticated legacy static uploads |
| `GET/HEAD /warehouse-test/*` | ✓ | ✓ | ✓ | ✓ | `app.js:57` | anonymous static test UI; only mounted outside production with ENABLE_TEST_API=true |
| `PATCH /api/admin/allegro-settings/accounts/:accountId` | — | — | — | ✓ | `routes/admin.js:49` | route-entry authorization |
| `PATCH /api/admin/baselinker-settings/accounts/:accountId` | — | — | — | ✓ | `routes/admin.js:103` | route-entry authorization |
| `PATCH /api/admin/cities/:id` | — | — | — | ✓ | `routes/admin.js:351` | route-entry authorization |
| `PATCH /api/allegro/{pickingPrefix}/items/:lineKey` | — | — | — | ✓ | `routes/allegro.js:252` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/baselinker/{pickingPrefix}/items/:lineKey` | — | — | — | ✓ | `routes/baseLinker.js:396` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/commerce/catalog/:id` | — | — | — | ✓ | `routes/commerce.js:242` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/commerce/categories/:id` | — | — | — | ✓ | `routes/commerce.js:209` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/delivery-groups/:id` | — | — | — | ✓ | `routes/deliveryGroups.js:265` | route-entry authorization |
| `PATCH /api/picking/tasks/:taskId/progress` | — | — | ✓ | ✓ | `routes/picking.js:1122` | route-entry authorization |
| `PATCH /api/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1459` | route-entry authorization |
| `PATCH /api/products/reorder` | — | — | ✓ | ✓ | `routes/products.js:961` | route-entry authorization |
| `PATCH /api/receipts/:id` | — | — | ✓ | ✓ | `routes/receipts.js:912` | route-entry authorization |
| `PATCH /api/receipts/:id/items/:itemId` | — | — | ✓ | ✓ | `routes/receipts.js:1179` | route-entry authorization |
| `PATCH /api/receipts/:id/items/:itemId/routing` | — | — | ✓ | ✓ | `routes/receipts.js:1889` | route-entry authorization |
| `PATCH /api/receipts/:id/items/:itemId/routing-correction` | — | — | ✓ | ✓ | `routes/receipts.js:2030` | route-entry authorization |
| `PATCH /api/receipts/items/routing-batch` | — | — | ✓ | ✓ | `routes/receipts.js:1661` | route-entry authorization |
| `PATCH /api/shop-products/:id` | — | — | ✓ | ✓ | `routes/shopProducts.js:321` | route-entry authorization |
| `PATCH /api/shops/:id` | — | — | — | ✓ | `routes/shops.js:327` | route entry only; response projection may vary by role |
| `PATCH /api/shops/:id/sellers` | — | — | — | ✓ | `routes/shops.js:377` | route entry only; response projection may vary by role |
| `PATCH /api/supplement/requests/:requestId` | — | ✓ | — | ✓ | `routes/supplement.js:249` | route-entry authorization |
| `PATCH /api/supplement/requests/:requestId/packed` | — | — | ✓ | ✓ | `routes/supplement.js:615` | route-entry authorization |
| `PATCH /api/users/:telegramId` | — | — | — | ✓ | `routes/users.js:213` | route-entry authorization |
| `PATCH /api/users/:telegramId/shop` | — | — | — | ✓ | `routes/users.js:186` | route-entry authorization |
| `PATCH /api/v1/orders/:id` | — | ✓ | ✓ | ✓ | `routes/orders.js:1700` | route entry only; ownership/shop/session checks run in handler |
| `PATCH /api/v1/orders/:id/snapshot` | — | — | ✓ | ✓ | `routes/orders.js:1157` | route entry only; ownership/shop/session checks run in handler |
| `PATCH /api/v1/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1459` | route-entry authorization |
| `PATCH /api/v1/products/reorder` | — | — | ✓ | ✓ | `routes/products.js:961` | route-entry authorization |
| `PATCH /api/v1/telegram/me/profile` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:306` | route-entry authorization |
| `PATCH /api/v1/telegram/me/shop` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:239` | route-entry authorization |
| `PATCH /api/vision-search/logs/:id` | — | — | ✓ | ✓ | `routes/visionSearch.js:444` | route-entry authorization |
| `POST /api/admin/allegro-settings/accounts` | — | — | — | ✓ | `routes/admin.js:40` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts` | — | — | — | ✓ | `routes/admin.js:81` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts/:accountId/queue` | — | — | — | ✓ | `routes/admin.js:161` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts/:accountId/refresh` | — | — | — | ✓ | `routes/admin.js:148` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts/:accountId/token` | — | — | — | ✓ | `routes/admin.js:136` | route-entry authorization |
| `POST /api/admin/baselinker-settings/validate` | — | — | — | ✓ | `routes/admin.js:75` | route-entry authorization |
| `POST /api/admin/cities` | — | — | — | ✓ | `routes/admin.js:337` | route-entry authorization |
| `POST /api/admin/openai/settings` | — | — | — | ✓ | `routes/admin.js:198` | route-entry authorization |
| `POST /api/admin/ordering-schedule` | — | — | — | ✓ | `routes/admin.js:297` | route-entry authorization |
| `POST /api/admin/price-groups` | — | — | — | ✓ | `routes/admin.js:691` | route-entry authorization |
| `POST /api/admin/supplement-settings` | — | — | — | ✓ | `routes/admin.js:319` | route-entry authorization |
| `POST /api/admin/telegram-groups` | — | — | — | ✓ | `routes/admin.js:451` | route-entry authorization |
| `POST /api/admin/telegram-groups/:groupId/check-all` | — | — | — | ✓ | `routes/admin.js:793` | route-entry authorization |
| `POST /api/admin/telegram-groups/:groupId/members/:telegramId/recheck` | — | — | — | ✓ | `routes/admin.js:777` | route-entry authorization |
| `POST /api/admin/telegram-member-tag-groups` | — | — | — | ✓ | `routes/admin.js:487` | route-entry authorization |
| `POST /api/admin/telegram-member-tags/reconcile` | — | — | — | ✓ | `routes/admin.js:535` | route-entry authorization |
| `POST /api/admin/telegram-new-products-bindings/:bindingId/identify` | — | — | — | ✓ | `routes/admin.js:645` | route-entry authorization |
| `POST /api/admin/telegram-new-products-bindings/:bindingId/resolve-absent` | — | — | — | ✓ | `routes/admin.js:634` | route-entry authorization |
| `POST /api/admin/telegram-new-products-cleanups/:cleanupId/resolve` | — | — | — | ✓ | `routes/admin.js:615` | route-entry authorization |
| `POST /api/admin/telegram-new-products-cleanups/:cleanupId/retry` | — | — | — | ✓ | `routes/admin.js:626` | route-entry authorization |
| `POST /api/admin/telegram-new-products-group` | — | — | — | ✓ | `routes/admin.js:601` | route-entry authorization |
| `POST /api/admin/telegram-support-admins` | — | — | — | ✓ | `routes/admin.js:553` | route-entry authorization |
| `POST /api/admin/vision-settings` | — | — | — | ✓ | `routes/admin.js:280` | route-entry authorization |
| `POST /api/allegro/{pickingPrefix}/claim` | — | — | — | ✓ | `routes/allegro.js:246` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/{pickingPrefix}/heartbeat` | — | — | — | ✓ | `routes/allegro.js:249` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/{pickingPrefix}/release` | — | — | — | ✓ | `routes/allegro.js:265` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/{pickingPrefix}/reopen` | — | — | — | ✓ | `routes/allegro.js:274` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/{pickingPrefix}/sent` | — | — | — | ✓ | `routes/allegro.js:268` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/{pickingPrefix}/upstream-reviewed` | — | — | — | ✓ | `routes/allegro.js:271` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/accounts/:accountId/connection-check` | — | — | — | ✓ | `routes/allegro.js:150` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/accounts/:accountId/oauth/start` | — | — | — | ✓ | `routes/allegro.js:144` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/accounts/:accountId/orders/:orderId/shipment/prepare` | — | — | — | ✓ | `routes/allegro.js:214` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/accounts/:accountId/orders/rebootstrap` | — | — | — | ✓ | `routes/allegro.js:182` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/accounts/:accountId/token-refresh` | — | — | — | ✓ | `routes/allegro.js:166` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/allegro/sync` | — | — | — | ✓ | `routes/allegro.js:278` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/archive/:id/restore` | — | — | ✓ | ✓ | `routes/archive.js:90` | route-entry authorization |
| `POST /api/baselinker/{pickingPrefix}/claim` | — | — | — | ✓ | `routes/baseLinker.js:394` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/{pickingPrefix}/heartbeat` | — | — | — | ✓ | `routes/baseLinker.js:395` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/{pickingPrefix}/packed` | — | — | — | ✓ | `routes/baseLinker.js:398` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/{pickingPrefix}/release` | — | — | — | ✓ | `routes/baseLinker.js:397` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/{pickingPrefix}/reopen` | — | — | — | ✓ | `routes/baseLinker.js:401` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/{pickingPrefix}/sent` | — | — | — | ✓ | `routes/baseLinker.js:399` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/{pickingPrefix}/upstream-reviewed` | — | — | — | ✓ | `routes/baseLinker.js:400` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/accounts/:accountId/orders/:orderId/packages/:packageId/print` | — | — | — | ✓ | `routes/baseLinker.js:325` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/accounts/:accountId/orders/:orderId/shipment/print` | — | — | — | ✓ | `routes/baseLinker.js:321` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/baselinker/sync` | — | — | — | ✓ | `routes/baseLinker.js:110` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/blocks` | — | — | ✓ | ✓ | `routes/blocks.js:172` | route-entry authorization |
| `POST /api/blocks/:number/add` | — | — | ✓ | ✓ | `routes/blocks.js:362` | route-entry authorization |
| `POST /api/blocks/move` | — | — | ✓ | ✓ | `routes/blocks.js:264` | route-entry authorization |
| `POST /api/commerce/catalog` | — | — | — | ✓ | `routes/commerce.js:231` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/catalog/import-warehouse` | — | — | — | ✓ | `routes/commerce.js:226` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/categories` | — | — | — | ✓ | `routes/commerce.js:204` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/providers/:provider/operations/:operation` | — | — | — | ✓ | `routes/commerce.js:51` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/activate` | — | — | — | ✓ | `routes/commerce.js:121` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/drafts` | — | — | — | ✓ | `routes/commerce.js:76` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/drafts/reconcile` | — | — | — | ✓ | `routes/commerce.js:89` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/drafts/status` | — | — | — | ✓ | `routes/commerce.js:83` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/health` | — | — | — | ✓ | `routes/commerce.js:193` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/lifecycle` | — | — | — | ✓ | `routes/commerce.js:184` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/lifecycle/preview` | — | — | — | ✓ | `routes/commerce.js:178` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/mapping/resolve` | — | — | — | ✓ | `routes/commerce.js:64` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/price-sync` | — | — | — | ✓ | `routes/commerce.js:152` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/price-sync/preview` | — | — | — | ✓ | `routes/commerce.js:146` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/sales-settings/apply` | — | — | — | ✓ | `routes/commerce.js:107` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/sales-settings/resolve` | — | — | — | ✓ | `routes/commerce.js:95` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/sales-settings/status` | — | — | — | ✓ | `routes/commerce.js:113` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/stock-sync` | — | — | — | ✓ | `routes/commerce.js:168` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/stock-sync/preview` | — | — | — | ✓ | `routes/commerce.js:162` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/update-content` | — | — | — | ✓ | `routes/commerce.js:137` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/update-preview` | — | — | — | ✓ | `routes/commerce.js:129` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/preview` | — | — | — | ✓ | `routes/commerce.js:58` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/delivery-groups` | — | — | — | ✓ | `routes/deliveryGroups.js:248` | route-entry authorization |
| `POST /api/delivery-groups/:id/broadcast` | — | — | — | ✓ | `routes/deliveryGroups.js:552` | route-entry authorization |
| `POST /api/delivery-groups/:id/close-ordering-session` | — | — | — | ✓ | `routes/deliveryGroups.js:152` | route-entry authorization |
| `POST /api/delivery-groups/catalog-reviewed` | — | ✓ | ✓ | ✓ | `routes/deliveryGroups.js:65` | route-entry authorization |
| `POST /api/picking/cancel-start` | — | — | ✓ | ✓ | `routes/picking.js:686` | route-entry authorization |
| `POST /api/picking/next-task` | — | — | ✓ | ✓ | `routes/picking.js:934` | route-entry authorization |
| `POST /api/picking/resolve-coverage-gap` | — | — | ✓ | ✓ | `routes/picking.js:768` | route-entry authorization |
| `POST /api/picking/start-session` | — | — | ✓ | ✓ | `routes/picking.js:319` | route-entry authorization |
| `POST /api/picking/tasks/:taskId/claim` | — | — | ✓ | ✓ | `routes/picking.js:1304` | route-entry authorization |
| `POST /api/picking/tasks/:taskId/complete` | — | — | ✓ | ✓ | `routes/picking.js:1091` | route-entry authorization |
| `POST /api/picking/tasks/:taskId/force-claim` | — | — | ✓ | ✓ | `routes/picking.js:1881` | route-entry authorization |
| `POST /api/picking/tasks/:taskId/heartbeat` | — | — | ✓ | ✓ | `routes/picking.js:1222` | route-entry authorization |
| `POST /api/picking/tasks/:taskId/out-of-stock` | — | — | ✓ | ✓ | `routes/picking.js:1381` | route-entry authorization |
| `POST /api/picking/tasks/:taskId/release` | — | — | ✓ | ✓ | `routes/picking.js:1185` | route-entry authorization |
| `POST /api/print-agent/heartbeat` | — | — | — | — | `routes/baseLinkerPrintAgent.js:32` | Print Agent token, not a user role |
| `POST /api/print-agent/jobs/:jobId/complete` | — | — | — | — | `routes/baseLinkerPrintAgent.js:77` | Print Agent token, not a user role |
| `POST /api/print-agent/jobs/:jobId/fail` | — | — | — | — | `routes/baseLinkerPrintAgent.js:82` | Print Agent token, not a user role |
| `POST /api/print-agent/jobs/:jobId/submitted` | — | — | — | — | `routes/baseLinkerPrintAgent.js:68` | Print Agent token, not a user role |
| `POST /api/print-agent/jobs/claim` | — | — | — | — | `routes/baseLinkerPrintAgent.js:43` | Print Agent token, not a user role |
| `POST /api/product-feedback` | — | ✓ | ✓ | ✓ | `routes/productFeedback.js:23` | route-entry authorization |
| `POST /api/product-feedback/:id/reject` | — | — | ✓ | ✓ | `routes/productFeedback.js:91` | route-entry authorization |
| `POST /api/product-feedback/:id/resolve` | — | — | ✓ | ✓ | `routes/productFeedback.js:78` | route-entry authorization |
| `POST /api/products` | — | — | ✓ | ✓ | `routes/products.js:1408` | route-entry authorization |
| `POST /api/products/:id/describe` | — | — | ✓ | ✓ | `routes/products.js:1701` | route-entry authorization |
| `POST /api/products/ask-group-price` | — | ✓ | ✓ | ✓ | `routes/products.js:430` | route-entry authorization |
| `POST /api/products/block-upload-photos` | — | — | ✓ | ✓ | `routes/products.js:1246` | route-entry authorization |
| `POST /api/products/broadcast` | — | ✓ | ✓ | ✓ | `routes/products.js:989` | route-entry authorization |
| `POST /api/products/receive` | — | — | ✓ | ✓ | `routes/products.js:1342` | route-entry authorization |
| `POST /api/products/report-missing` | — | ✓ | ✓ | ✓ | `routes/products.js:1010` | route-entry authorization |
| `POST /api/receipts` | — | — | ✓ | ✓ | `routes/receipts.js:876` | route-entry authorization |
| `POST /api/receipts/:id/commit` | — | — | ✓ | ✓ | `routes/receipts.js:2450` | route-entry authorization |
| `POST /api/receipts/:id/items` | — | — | ✓ | ✓ | `routes/receipts.js:949` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/add-warehouse-remainder` | — | — | ✓ | ✓ | `routes/receipts.js:2067` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/confirm` | — | — | ✓ | ✓ | `routes/receipts.js:2175` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/describe` | — | — | ✓ | ✓ | `routes/receipts.js:2790` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/log` | — | — | ✓ | ✓ | `routes/receipts.js:2828` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/telegram-new-product` | — | — | ✓ | ✓ | `routes/receipts.js:1522` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/telegram-new-product/attach` | — | — | ✓ | ✓ | `routes/receipts.js:1493` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/telegram-new-product/verify` | — | — | ✓ | ✓ | `routes/receipts.js:1477` | route-entry authorization |
| `POST /api/receipts/:id/items/:itemId/unconfirm` | — | — | ✓ | ✓ | `routes/receipts.js:2350` | route-entry authorization |
| `POST /api/receipts/bulk-intake` | — | — | ✓ | ✓ | `routes/receipts.js:763` | route-entry authorization |
| `POST /api/receipts/supplement-batches/:deliveryGroupId/publish` | — | — | ✓ | ✓ | `routes/receipts.js:534` | route-entry authorization |
| `POST /api/search-products/resend` | — | ✓ | ✓ | ✓ | `routes/searchProducts.js:108` | route-entry authorization |
| `POST /api/shop-products` | — | — | ✓ | ✓ | `routes/shopProducts.js:165` | route-entry authorization |
| `POST /api/shop-products/:id/describe` | — | — | ✓ | ✓ | `routes/shopProducts.js:428` | route-entry authorization |
| `POST /api/shop-products/migrate-from-products` | — | — | — | ✓ | `routes/shopProducts.js:544` | route-entry authorization |
| `POST /api/shop-transfer` | — | ✓ | — | — | `routes/shopTransfer.js:101` | route-entry authorization |
| `POST /api/shop-transfer/:id/approve` | — | — | — | ✓ | `routes/shopTransfer.js:194` | route-entry authorization |
| `POST /api/shop-transfer/:id/reject` | — | — | — | ✓ | `routes/shopTransfer.js:325` | route-entry authorization |
| `POST /api/shops` | — | — | — | ✓ | `routes/shops.js:303` | route entry only; response projection may vary by role |
| `POST /api/shops/:id/invite-link` | — | — | — | ✓ | `routes/shops.js:500` | route entry only; response projection may vary by role |
| `POST /api/supplement/:offerId/request` | — | ✓ | — | ✓ | `routes/supplement.js:268` | route-entry authorization |
| `POST /api/supplement/offers/:offerId/cancel` | — | — | ✓ | ✓ | `routes/supplement.js:568` | route-entry authorization |
| `POST /api/supplement/offers/:offerId/claim` | — | — | ✓ | ✓ | `routes/supplement.js:587` | route-entry authorization |
| `POST /api/supplement/offers/:offerId/complete` | — | — | ✓ | ✓ | `routes/supplement.js:652` | route-entry authorization |
| `POST /api/supplement/offers/:offerId/heartbeat` | — | — | ✓ | ✓ | `routes/supplement.js:603` | route-entry authorization |
| `POST /api/supplement/offers/:offerId/release` | — | — | ✓ | ✓ | `routes/supplement.js:609` | route-entry authorization |
| `POST /api/supplement/offers/:offerId/requests` | — | ✓ | — | ✓ | `routes/supplement.js:238` | route-entry authorization |
| `POST /api/supplement/receipts/:receiptId/freeze` | — | — | ✓ | ✓ | `routes/supplement.js:517` | route-entry authorization |
| `POST /api/supplement/requests/:requestId/cancel` | — | — | ✓ | ✓ | `routes/supplement.js:531` | route-entry authorization |
| `POST /api/supplement/requests/:requestId/restore` | — | — | ✓ | ✓ | `routes/supplement.js:555` | route-entry authorization |
| `POST /api/supplement/waves/:waveId/cancel` | — | — | ✓ | ✓ | `routes/supplement.js:503` | route-entry authorization |
| `POST /api/supplement/waves/:waveId/freeze` | — | — | ✓ | ✓ | `routes/supplement.js:487` | route-entry authorization |
| `POST /api/users` | — | — | — | ✓ | `routes/users.js:152` | route-entry authorization |
| `POST /api/users/:telegramId/cleared-carts/:cartId/restore` | — | — | — | ✓ | `routes/users.js:145` | route-entry authorization |
| `POST /api/v1/auth/google` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:114` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/auth/google/link/bootstrap` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:135` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/auth/google/link/complete` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:155` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/auth/logout` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:235` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/auth/telegram/bootstrap` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:90` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/orders` | — | ✓ | ✓ | ✓ | `routes/orders.js:724` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/:id/fulfill` | — | — | ✓ | ✓ | `routes/orders.js:691` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/:id/stale/expire` | — | — | — | ✓ | `routes/orders.js:1643` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/:id/stale/restore-to-cart` | — | — | — | ✓ | `routes/orders.js:1409` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/conflicts/resolve` | — | — | ✓ | ✓ | `routes/orders.js:419` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/remove-item` | — | ✓ | ✓ | ✓ | `routes/orders.js:1984` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/set-item-qty` | — | ✓ | ✓ | ✓ | `routes/orders.js:1911` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/upsert-item` | — | ✓ | ✓ | ✓ | `routes/orders.js:1707` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/products` | — | — | ✓ | ✓ | `routes/products.js:1408` | route-entry authorization |
| `POST /api/v1/products/:id/describe` | — | — | ✓ | ✓ | `routes/products.js:1701` | route-entry authorization |
| `POST /api/v1/products/ask-group-price` | — | ✓ | ✓ | ✓ | `routes/products.js:430` | route-entry authorization |
| `POST /api/v1/products/block-upload-photos` | — | — | ✓ | ✓ | `routes/products.js:1246` | route-entry authorization |
| `POST /api/v1/products/broadcast` | — | ✓ | ✓ | ✓ | `routes/products.js:989` | route-entry authorization |
| `POST /api/v1/products/receive` | — | — | ✓ | ✓ | `routes/products.js:1342` | route-entry authorization |
| `POST /api/v1/products/report-missing` | — | ✓ | ✓ | ✓ | `routes/products.js:1010` | route-entry authorization |
| `POST /api/v1/telegram/google/link/start` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:346` | route-entry authorization |
| `POST /api/v1/telegram/google/unlink` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:358` | route-entry authorization |
| `POST /api/v1/telegram/me` | ✓ | ✓ | ✓ | ✓ | `routes/v1/telegram.js:214` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/telegram/mini-app/reset-state` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:505` | route-entry authorization |
| `POST /api/v1/telegram/mini-app/state` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:384` | route-entry authorization |
| `POST /api/v1/telegram/register-request` | ✓ | ✓ | ✓ | ✓ | `routes/v1/telegram.js:617` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/telegram/register-requests/:id/approve` | — | — | — | ✓ | `routes/v1/telegram.js:795` | route-entry authorization |
| `POST /api/v1/telegram/register-requests/:id/block` | — | — | — | ✓ | `routes/v1/telegram.js:892` | route-entry authorization |
| `POST /api/v1/telegram/register-requests/:id/reject` | — | — | — | ✓ | `routes/v1/telegram.js:882` | route-entry authorization |
| `POST /api/v1/telegram/register-requests/:id/unblock` | — | — | — | ✓ | `routes/v1/telegram.js:902` | route-entry authorization |
| `POST /api/v1/telegram/registration-invite` | ✓ | ✓ | ✓ | ✓ | `routes/v1/telegram.js:545` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/v1/telegram/validate` | ✓ | ✓ | ✓ | ✓ | `routes/v1/telegram.js:208` | public allowlist; endpoint-specific proof/rate limits may still apply |
| `POST /api/vision-search/ask` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:404` | route-entry authorization |
| `POST /api/vision-search/describe` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:361` | route-entry authorization |
| `POST /api/vision-search/embed-all` | — | — | — | ✓ | `routes/visionSearch.js:126` | route-entry authorization |
| `POST /api/vision-search/query-text` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:238` | route-entry authorization |
| `POST /api/vision-search/query-vector` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:159` | route-entry authorization |
| `POST /api/vision-search/query-vector-warehouse` | — | — | ✓ | ✓ | `routes/visionSearch.js:318` | route-entry authorization |
| `POST /api/vision-search/translate-label` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:383` | route-entry authorization |
| `POST /api/warehouse-test/cleanup` | — | — | — | ✓ | `routes/warehouseTest.js:170` | admin and ENABLE_TEST_API outside production |
| `POST /api/warehouse-test/run` | — | — | — | ✓ | `routes/warehouseTest.js:229` | admin and ENABLE_TEST_API outside production |
| `POST /api/warehouse-test/seed-conflicts` | — | — | — | ✓ | `routes/warehouseTest.js:779` | admin and ENABLE_TEST_API outside production |
| `POST /api/warehouse-test/start-picking` | — | — | — | ✓ | `routes/warehouseTest.js:981` | admin and ENABLE_TEST_API outside production |
| `POST /api/warehouse-test/suite/run` | — | — | — | ✓ | `routes/warehouseTest.js:1084` | admin and ENABLE_TEST_API outside production |
| `POST /api/warehouse-test/suite/stop/:jobId` | — | — | — | ✓ | `routes/warehouseTest.js:1151` | admin and ENABLE_TEST_API outside production |
| `POST /api/warehouse-test/test-upload-image` | — | — | — | ✓ | `routes/warehouseTest.js:1184` | admin and ENABLE_TEST_API outside production |
| `POST /telegram-webhook/<token-derived-path>` | ✓ | — | — | — | `app.js:67` | Telegram secret-token header + unguessable path; no app user role |
| `PUT /api/admin/openai-key` | — | — | — | ✓ | `routes/admin.js:429` | route-entry authorization |
| `PUT /api/commerce/publications/allegro/mapping` | — | — | — | ✓ | `routes/commerce.js:70` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PUT /api/commerce/publications/allegro/sales-settings` | — | — | — | ✓ | `routes/commerce.js:101` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |

## Coverage contract

Run `npm run test:security:endpoint-matrix`. The check re-scans every `app.METHOD` and `router.METHOD` declaration,
rebuilds this table, and fails if a route, mount, role guard, or source line changes without an explicit review.

The conditional warehouse-test router/static UI are included even though production cannot mount them. The Telegram
webhook and Print Agent endpoints are listed, but their non-user credentials are intentionally not treated as user roles.
The separate `baselinker` provider-worker role is deliberately outside this requested four-role table.
