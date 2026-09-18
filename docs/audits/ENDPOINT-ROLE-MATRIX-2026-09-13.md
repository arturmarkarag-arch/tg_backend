# Endpoint × role inventory — 2026-09-13

This is a complete inventory of runtime Express route declarations, discovered router mounts, and static surfaces.
A check mark means that the role passes the route-entry auth/role middleware. Resource ownership, shop/group/session
scope, one-time tokens, rate limits, feature flags, and request validation can still deny a request as noted.

Routes: **475** · anonymous: **7** · seller: **74** · warehouse: **199** · admin: **465**

| Endpoint | Anonymous | Seller | Warehouse | Admin | Source | Boundary note |
|---|:---:|:---:|:---:|:---:|---|---|
| `DELETE /api/admin/allegro-settings/accounts/:accountId` | — | — | — | ✓ | `routes/admin.js:55` | route-entry authorization |
| `DELETE /api/admin/cities/:id` | — | — | — | ✓ | `routes/admin.js:372` | route-entry authorization |
| `DELETE /api/admin/price-groups/:groupId` | — | — | — | ✓ | `routes/admin.js:725` | route-entry authorization |
| `DELETE /api/admin/telegram-groups/:groupId` | — | — | — | ✓ | `routes/admin.js:478` | route-entry authorization |
| `DELETE /api/admin/telegram-groups/:groupId/members/:telegramId` | — | — | — | ✓ | `routes/admin.js:759` | route-entry authorization |
| `DELETE /api/admin/telegram-member-tag-groups/:groupId` | — | — | — | ✓ | `routes/admin.js:532` | route-entry authorization |
| `DELETE /api/admin/telegram-support-admins/:username` | — | — | — | ✓ | `routes/admin.js:596` | route-entry authorization |
| `DELETE /api/blocks/:number` | — | — | ✓ | ✓ | `routes/blocks.js:395` | route-entry authorization |
| `DELETE /api/blocks/:number/products/:productId` | — | — | ✓ | ✓ | `routes/blocks.js:323` | route-entry authorization |
| `DELETE /api/delivery-groups/:id` | — | — | — | ✓ | `routes/deliveryGroups.js:478` | route-entry authorization |
| `DELETE /api/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1678` | route-entry authorization |
| `DELETE /api/products/orphan-photo` | — | — | ✓ | ✓ | `routes/products.js:384` | route-entry authorization |
| `DELETE /api/receipts/:id` | — | — | ✓ | ✓ | `routes/receipts.js:729` | route-entry authorization |
| `DELETE /api/receipts/:id/items/:itemId` | — | — | ✓ | ✓ | `routes/receipts.js:1559` | route-entry authorization |
| `DELETE /api/shop-products/:id` | — | — | ✓ | ✓ | `routes/shopProducts.js:515` | route-entry authorization |
| `DELETE /api/shop-transfer/my` | — | ✓ | — | — | `routes/shopTransfer.js:158` | route-entry authorization |
| `DELETE /api/shops/:id` | — | — | — | ✓ | `routes/shops.js:341` | route entry only; response projection may vary by role |
| `DELETE /api/supplement/:offerId/request` | — | ✓ | — | ✓ | `routes/supplement.js:281` | route-entry authorization |
| `DELETE /api/supplement/requests/:requestId` | — | ✓ | — | ✓ | `routes/supplement.js:259` | route-entry authorization |
| `DELETE /api/users/:telegramId` | — | — | — | ✓ | `routes/users.js:285` | route-entry authorization |
| `DELETE /api/v1/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1678` | route-entry authorization |
| `DELETE /api/v1/products/orphan-photo` | — | — | ✓ | ✓ | `routes/products.js:384` | route-entry authorization |
| `DELETE /api/v1/telegram/register-requests/:id` | — | — | — | ✓ | `routes/v1/telegram.js:927` | route-entry authorization |
| `DELETE /api/vision-search/logs` | — | — | — | ✓ | `routes/visionSearch.js:456` | route-entry authorization |
| `GET /api/admin/allegro-settings` | — | — | — | ✓ | `routes/admin.js:35` | route-entry authorization |
| `GET /api/admin/baselinker-settings` | — | — | — | ✓ | `routes/admin.js:60` | route-entry authorization |
| `GET /api/admin/baselinker-settings/accounts/:accountId/statuses` | — | — | — | ✓ | `routes/admin.js:156` | route-entry authorization |
| `GET /api/admin/cities` | — | — | — | ✓ | `routes/admin.js:332` | route-entry authorization |
| `GET /api/admin/egress-traffic` | — | — | — | ✓ | `routes/admin.js:826` | route-entry authorization |
| `GET /api/admin/openai-key` | — | — | — | ✓ | `routes/admin.js:416` | route-entry authorization |
| `GET /api/admin/openai/costs` | — | — | — | ✓ | `routes/admin.js:846` | route-entry authorization |
| `GET /api/admin/openai/models` | — | — | — | ✓ | `routes/admin.js:187` | route-entry authorization |
| `GET /api/admin/openai/settings` | — | — | — | ✓ | `routes/admin.js:193` | route-entry authorization |
| `GET /api/admin/openai/usage` | — | — | — | ✓ | `routes/admin.js:859` | route-entry authorization |
| `GET /api/admin/ordering-schedule` | — | — | — | ✓ | `routes/admin.js:293` | route-entry authorization |
| `GET /api/admin/price-groups` | — | — | — | ✓ | `routes/admin.js:699` | route-entry authorization |
| `GET /api/admin/supplement-settings` | — | — | — | ✓ | `routes/admin.js:316` | route-entry authorization |
| `GET /api/admin/telegram-delivery/events` | — | — | — | ✓ | `routes/admin.js:214` | route-entry authorization |
| `GET /api/admin/telegram-delivery/events/:eventKey` | — | — | — | ✓ | `routes/admin.js:224` | route-entry authorization |
| `GET /api/admin/telegram-groups` | — | — | — | ✓ | `routes/admin.js:443` | route-entry authorization |
| `GET /api/admin/telegram-groups/:groupId/members` | — | — | — | ✓ | `routes/admin.js:739` | route-entry authorization |
| `GET /api/admin/telegram-member-tag-groups` | — | — | — | ✓ | `routes/admin.js:498` | route-entry authorization |
| `GET /api/admin/telegram-member-tags` | — | — | — | ✓ | `routes/admin.js:545` | route-entry authorization |
| `GET /api/admin/telegram-new-products-group` | — | — | — | ✓ | `routes/admin.js:606` | route-entry authorization |
| `GET /api/admin/telegram-new-products-history` | — | — | — | ✓ | `routes/admin.js:679` | route-entry authorization |
| `GET /api/admin/telegram-support-admins` | — | — | — | ✓ | `routes/admin.js:565` | route-entry authorization |
| `GET /api/admin/vision-settings` | — | — | — | ✓ | `routes/admin.js:276` | route-entry authorization |
| `GET /api/allegro/accounts/:accountId/orders/:orderId` | — | — | — | ✓ | `routes/allegro.js:201` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/accounts/:accountId/orders/:orderId/picking` | — | — | — | ✓ | `routes/allegro.js:241` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/accounts/:accountId/orders/:orderId/shipment` | — | — | — | ✓ | `routes/allegro.js:209` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/accounts/:accountId/orders/:orderId/shipment/label` | — | — | — | ✓ | `routes/allegro.js:219` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/api-usage` | — | — | — | ✓ | `routes/allegro.js:129` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/errors` | — | — | — | ✓ | `routes/allegro.js:135` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/allegro/oauth/callback` | ✓ | ✓ | ✓ | ✓ | `routes/allegro.js:50` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
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
| `GET /api/bot-status` | — | — | — | ✓ | `app.js:153` | route-entry authorization |
| `GET /api/commerce/catalog` | — | — | — | ✓ | `routes/commerce.js:97` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/catalog/:id` | — | — | — | ✓ | `routes/commerce.js:119` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/catalog/warehouse-products` | — | — | — | ✓ | `routes/commerce.js:103` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/categories` | — | — | — | ✓ | `routes/commerce.js:82` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/integrations` | — | — | — | ✓ | `routes/commerce.js:23` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/commerce/providers` | — | — | — | ✓ | `routes/commerce.js:29` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `GET /api/delivery-groups` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:243` | route-entry authorization |
| `GET /api/delivery-groups/:groupId/shop-status` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:118` | route-entry authorization |
| `GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:136` | route-entry authorization |
| `GET /api/delivery-groups/ordering-status` | — | ✓ | ✓ | ✓ | `routes/deliveryGroups.js:49` | route-entry authorization |
| `GET /api/delivery-groups/session-summaries` | — | — | — | ✓ | `routes/deliveryGroups.js:147` | route-entry authorization |
| `GET /api/delivery-groups/summary` | — | — | ✓ | ✓ | `routes/deliveryGroups.js:109` | route-entry authorization |
| `GET /api/gemini-status` | — | — | — | ✓ | `app.js:171` | route-entry authorization |
| `GET /api/health` | ✓ | ✓ | ✓ | ✓ | `app.js:137` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
| `GET /api/invoices` | — | — | — | ✓ | `routes/invoices.js:540` | route-entry authorization |
| `GET /api/invoices/:id` | — | — | — | ✓ | `routes/invoices.js:639` | route-entry authorization |
| `GET /api/invoices/:id/fiscal/ksef/pdf-visualization` | — | — | — | ✓ | `routes/invoices.js:607` | route-entry authorization |
| `GET /api/invoices/:id/fiscal/ksef/status` | — | — | — | ✓ | `routes/invoices.js:592` | route-entry authorization |
| `GET /api/invoices/:id/fiscal/ksef/upo` | — | — | — | ✓ | `routes/invoices.js:625` | route-entry authorization |
| `GET /api/invoices/:id/fiscal/ksef/xml` | — | — | — | ✓ | `routes/invoices.js:614` | route-entry authorization |
| `GET /api/invoices/business-counterparties` | — | — | — | ✓ | `routes/invoices.js:334` | route-entry authorization |
| `GET /api/invoices/ksef/certificate-enrollments` | — | — | — | ✓ | `routes/invoices.js:269` | route-entry authorization |
| `GET /api/invoices/ksef/certificate-enrollments/:enrollmentId` | — | — | — | ✓ | `routes/invoices.js:285` | route-entry authorization |
| `GET /api/invoices/ksef/certificate-limits` | — | — | — | ✓ | `routes/invoices.js:262` | route-entry authorization |
| `GET /api/invoices/ksef/connections` | — | — | — | ✓ | `routes/invoices.js:203` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-documents` | — | — | — | ✓ | `routes/invoices.js:413` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-documents/:documentId` | — | — | — | ✓ | `routes/invoices.js:425` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-documents/:documentId/business-links` | — | — | — | ✓ | `routes/invoices.js:437` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-documents/:documentId/xml` | — | — | — | ✓ | `routes/invoices.js:461` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-exports` | — | — | — | ✓ | `routes/invoices.js:386` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-exports/:exportId` | — | — | — | ✓ | `routes/invoices.js:399` | route-entry authorization |
| `GET /api/invoices/ksef/inbound-syncs` | — | — | — | ✓ | `routes/invoices.js:352` | route-entry authorization |
| `GET /api/invoices/ksef/offline-certificates` | — | — | — | ✓ | `routes/invoices.js:310` | route-entry authorization |
| `GET /api/invoices/ksef/ops/events` | — | — | — | ✓ | `routes/invoices.js:176` | route-entry authorization |
| `GET /api/invoices/ksef/ops/issues` | — | — | — | ✓ | `routes/invoices.js:162` | route-entry authorization |
| `GET /api/invoices/ksef/ops/readiness` | — | — | — | ✓ | `routes/invoices.js:156` | route-entry authorization |
| `GET /api/invoices/ksef/technical-corrections/:correctionId` | — | — | — | ✓ | `routes/invoices.js:486` | route-entry authorization |
| `GET /api/invoices/ksef/technical-corrections/:correctionId/upo` | — | — | — | ✓ | `routes/invoices.js:493` | route-entry authorization |
| `GET /api/invoices/ksef/xades-credentials` | — | — | — | ✓ | `routes/invoices.js:234` | route-entry authorization |
| `GET /api/invoices/legal-entities` | — | — | — | ✓ | `routes/invoices.js:128` | route-entry authorization |
| `GET /api/invoices/legal-entities/:id` | — | — | — | ✓ | `routes/invoices.js:140` | route-entry authorization |
| `GET /api/invoices/meta` | — | — | — | ✓ | `routes/invoices.js:118` | route-entry authorization |
| `GET /api/maintenance` | — | ✓ | ✓ | ✓ | `app.js:149` | route-entry authorization |
| `GET /api/nav-badges` | — | ✓ | ✓ | ✓ | `routes/navBadges.js:91` | route-entry authorization |
| `GET /api/openai-status` | — | — | — | ✓ | `app.js:157` | route-entry authorization |
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
| `GET /api/products` | — | — | ✓ | ✓ | `routes/products.js:661` | route-entry authorization |
| `GET /api/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1235` | route-entry authorization |
| `GET /api/products/:id/position` | — | — | ✓ | ✓ | `routes/products.js:598` | route-entry authorization |
| `GET /api/products/:id/who-ordered` | — | — | ✓ | ✓ | `routes/products.js:1158` | route-entry authorization |
| `GET /api/products/catalog` | — | ✓ | ✓ | ✓ | `routes/products.js:515` | route-entry authorization |
| `GET /api/products/catalog/:id/position` | — | ✓ | ✓ | ✓ | `routes/products.js:557` | route-entry authorization |
| `GET /api/products/check` | — | — | ✓ | ✓ | `routes/products.js:822` | route-entry authorization |
| `GET /api/products/drafts` | — | — | ✓ | ✓ | `routes/products.js:463` | route-entry authorization |
| `GET /api/products/new-list` | — | ✓ | ✓ | ✓ | `routes/products.js:924` | route-entry authorization |
| `GET /api/products/pending` | — | — | ✓ | ✓ | `routes/products.js:853` | route-entry authorization |
| `GET /api/products/proxy-image` | — | — | ✓ | ✓ | `routes/products.js:1209` | route-entry authorization |
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
| `GET /api/shops` | — | ✓ | ✓ | ✓ | `routes/shops.js:40` | route entry only; response projection may vary by role |
| `GET /api/shops/:id` | — | ✓ | ✓ | ✓ | `routes/shops.js:285` | route entry only; response projection may vary by role |
| `GET /api/shops/cities` | — | ✓ | ✓ | ✓ | `routes/shops.js:222` | first-party session proof required before route; pre-registration/browser probe path |
| `GET /api/shops/reference` | — | — | ✓ | ✓ | `routes/shops.js:275` | route entry only; response projection may vary by role |
| `GET /api/shops/registry` | — | ✓ | ✓ | ✓ | `routes/shops.js:236` | first-party session proof required before route; pre-registration/browser probe path |
| `GET /api/shops/without-seller` | — | — | ✓ | ✓ | `routes/shops.js:248` | route entry only; response projection may vary by role |
| `GET /api/supplement/admin/seller/:telegramId` | — | — | — | ✓ | `routes/supplement.js:344` | route-entry authorization |
| `GET /api/supplement/available` | — | ✓ | — | ✓ | `routes/supplement.js:156` | route-entry authorization |
| `GET /api/supplement/group/:deliveryGroupId` | — | — | ✓ | ✓ | `routes/supplement.js:420` | route-entry authorization |
| `GET /api/supplement/my` | — | ✓ | — | ✓ | `routes/supplement.js:293` | route-entry authorization |
| `GET /api/supplement/offers/:offerId` | — | — | ✓ | ✓ | `routes/supplement.js:580` | route-entry authorization |
| `GET /api/users` | — | — | — | ✓ | `routes/users.js:74` | route-entry authorization |
| `GET /api/users/:telegramId` | — | — | — | ✓ | `routes/users.js:121` | route-entry authorization |
| `GET /api/users/:telegramId/cleared-carts` | — | — | — | ✓ | `routes/users.js:129` | route-entry authorization |
| `GET /api/users/assignment-candidates` | — | — | — | ✓ | `routes/users.js:101` | route-entry authorization |
| `GET /api/v1/auth/config` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:123` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
| `GET /api/v1/auth/me` | — | ✓ | ✓ | ✓ | `routes/v1/auth.js:240` | first-party session proof required before route; pre-registration/browser probe path |
| `GET /api/v1/orders` | — | ✓ | ✓ | ✓ | `routes/orders.js:486` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/:id` | — | ✓ | ✓ | ✓ | `routes/orders.js:699` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/conflicts` | — | — | ✓ | ✓ | `routes/orders.js:339` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/current-items` | — | ✓ | — | ✓ | `routes/orders.js:596` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/orders/transit/active` | — | — | ✓ | ✓ | `routes/orders.js:648` | route entry only; ownership/shop/session checks run in handler |
| `GET /api/v1/products` | — | — | ✓ | ✓ | `routes/products.js:661` | route-entry authorization |
| `GET /api/v1/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1235` | route-entry authorization |
| `GET /api/v1/products/:id/position` | — | — | ✓ | ✓ | `routes/products.js:598` | route-entry authorization |
| `GET /api/v1/products/:id/who-ordered` | — | — | ✓ | ✓ | `routes/products.js:1158` | route-entry authorization |
| `GET /api/v1/products/catalog` | — | ✓ | ✓ | ✓ | `routes/products.js:515` | route-entry authorization |
| `GET /api/v1/products/catalog/:id/position` | — | ✓ | ✓ | ✓ | `routes/products.js:557` | route-entry authorization |
| `GET /api/v1/products/check` | — | — | ✓ | ✓ | `routes/products.js:822` | route-entry authorization |
| `GET /api/v1/products/drafts` | — | — | ✓ | ✓ | `routes/products.js:463` | route-entry authorization |
| `GET /api/v1/products/new-list` | — | ✓ | ✓ | ✓ | `routes/products.js:924` | route-entry authorization |
| `GET /api/v1/products/pending` | — | — | ✓ | ✓ | `routes/products.js:853` | route-entry authorization |
| `GET /api/v1/products/proxy-image` | — | — | ✓ | ✓ | `routes/products.js:1209` | route-entry authorization |
| `GET /api/v1/products/upload-url` | — | — | ✓ | ✓ | `routes/products.js:303` | route-entry authorization |
| `GET /api/v1/products/upload-url-pair` | — | — | ✓ | ✓ | `routes/products.js:332` | route-entry authorization |
| `GET /api/v1/products/upload-url-public` | — | ✓ | ✓ | ✓ | `routes/products.js:404` | route-entry authorization |
| `GET /api/v1/products/upload-url-triple` | — | — | ✓ | ✓ | `routes/products.js:362` | route-entry authorization |
| `GET /api/v1/products/warehouse-stats` | — | — | ✓ | ✓ | `routes/products.js:192` | route-entry authorization |
| `GET /api/v1/telegram/register-requests` | — | — | — | ✓ | `routes/v1/telegram.js:798` | route-entry authorization |
| `GET /api/vision-search/logs` | — | — | ✓ | ✓ | `routes/visionSearch.js:426` | route-entry authorization |
| `GET /api/vision-search/upload-url` | — | ✓ | ✓ | ✓ | `routes/visionSearch.js:54` | route-entry authorization |
| `GET /api/warehouse-test/health` | — | — | — | ✓ | `routes/warehouseTest.js:118` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/jobs` | — | — | — | ✓ | `routes/warehouseTest.js:1035` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/status/:jobId` | — | — | — | ✓ | `routes/warehouseTest.js:1028` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/suite/list` | — | — | — | ✓ | `routes/warehouseTest.js:1164` | admin and ENABLE_TEST_API outside production |
| `GET /api/warehouse-test/suite/status/:jobId` | — | — | — | ✓ | `routes/warehouseTest.js:1139` | admin and ENABLE_TEST_API outside production |
| `GET/HEAD /uploads/*` | — | — | ✓ | ✓ | `app.js:55` | authenticated legacy static uploads |
| `GET/HEAD /warehouse-test/*` | — | — | — | ✓ | `app.js:111` | admin-authenticated static test UI; only mounted outside production with ENABLE_TEST_API=true |
| `PATCH /api/admin/allegro-settings/accounts/:accountId` | — | — | — | ✓ | `routes/admin.js:50` | route-entry authorization |
| `PATCH /api/admin/baselinker-settings/accounts/:accountId` | — | — | — | ✓ | `routes/admin.js:104` | route-entry authorization |
| `PATCH /api/admin/cities/:id` | — | — | — | ✓ | `routes/admin.js:352` | route-entry authorization |
| `PATCH /api/allegro/{pickingPrefix}/items/:lineKey` | — | — | — | ✓ | `routes/allegro.js:252` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/baselinker/{pickingPrefix}/items/:lineKey` | — | — | — | ✓ | `routes/baseLinker.js:396` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/commerce/catalog/:id` | — | — | — | ✓ | `routes/commerce.js:125` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/commerce/categories/:id` | — | — | — | ✓ | `routes/commerce.js:92` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PATCH /api/delivery-groups/:id` | — | — | — | ✓ | `routes/deliveryGroups.js:265` | route-entry authorization |
| `PATCH /api/invoices/:id` | — | — | — | ✓ | `routes/invoices.js:650` | route-entry authorization |
| `PATCH /api/invoices/business-counterparties/:id` | — | — | — | ✓ | `routes/invoices.js:346` | route-entry authorization |
| `PATCH /api/invoices/ksef/connections/:connectionId` | — | — | — | ✓ | `routes/invoices.js:215` | route-entry authorization |
| `PATCH /api/invoices/ksef/inbound-syncs/:syncId` | — | — | — | ✓ | `routes/invoices.js:368` | route-entry authorization |
| `PATCH /api/invoices/ksef/offline-certificates/:certificateId` | — | — | — | ✓ | `routes/invoices.js:327` | route-entry authorization |
| `PATCH /api/invoices/ksef/xades-credentials/:credentialId` | — | — | — | ✓ | `routes/invoices.js:249` | route-entry authorization |
| `PATCH /api/invoices/legal-entities/:id` | — | — | — | ✓ | `routes/invoices.js:147` | route-entry authorization |
| `PATCH /api/picking/tasks/:taskId/progress` | — | — | ✓ | ✓ | `routes/picking.js:1122` | route-entry authorization |
| `PATCH /api/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1460` | route-entry authorization |
| `PATCH /api/products/reorder` | — | — | ✓ | ✓ | `routes/products.js:962` | route-entry authorization |
| `PATCH /api/receipts/:id` | — | — | ✓ | ✓ | `routes/receipts.js:912` | route-entry authorization |
| `PATCH /api/receipts/:id/items/:itemId` | — | — | ✓ | ✓ | `routes/receipts.js:1179` | route-entry authorization |
| `PATCH /api/receipts/:id/items/:itemId/routing` | — | — | ✓ | ✓ | `routes/receipts.js:1889` | route-entry authorization |
| `PATCH /api/receipts/:id/items/:itemId/routing-correction` | — | — | ✓ | ✓ | `routes/receipts.js:2030` | route-entry authorization |
| `PATCH /api/receipts/items/routing-batch` | — | — | ✓ | ✓ | `routes/receipts.js:1661` | route-entry authorization |
| `PATCH /api/shop-products/:id` | — | — | ✓ | ✓ | `routes/shopProducts.js:321` | route-entry authorization |
| `PATCH /api/shops/:id` | — | — | — | ✓ | `routes/shops.js:329` | route entry only; response projection may vary by role |
| `PATCH /api/shops/:id/sellers` | — | — | — | ✓ | `routes/shops.js:379` | route entry only; response projection may vary by role |
| `PATCH /api/supplement/requests/:requestId` | — | ✓ | — | ✓ | `routes/supplement.js:249` | route-entry authorization |
| `PATCH /api/supplement/requests/:requestId/packed` | — | — | ✓ | ✓ | `routes/supplement.js:615` | route-entry authorization |
| `PATCH /api/users/:telegramId` | — | — | — | ✓ | `routes/users.js:223` | route-entry authorization |
| `PATCH /api/users/:telegramId/shop` | — | — | — | ✓ | `routes/users.js:196` | route-entry authorization |
| `PATCH /api/v1/orders/:id` | — | ✓ | ✓ | ✓ | `routes/orders.js:1700` | route entry only; ownership/shop/session checks run in handler |
| `PATCH /api/v1/orders/:id/snapshot` | — | — | ✓ | ✓ | `routes/orders.js:1157` | route entry only; ownership/shop/session checks run in handler |
| `PATCH /api/v1/products/:id` | — | — | ✓ | ✓ | `routes/products.js:1460` | route-entry authorization |
| `PATCH /api/v1/products/reorder` | — | — | ✓ | ✓ | `routes/products.js:962` | route-entry authorization |
| `PATCH /api/v1/telegram/me/profile` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:317` | route-entry authorization |
| `PATCH /api/v1/telegram/me/shop` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:250` | route-entry authorization |
| `PATCH /api/vision-search/logs/:id` | — | — | ✓ | ✓ | `routes/visionSearch.js:444` | route-entry authorization |
| `POST /api/admin/allegro-settings/accounts` | — | — | — | ✓ | `routes/admin.js:41` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts` | — | — | — | ✓ | `routes/admin.js:82` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts/:accountId/queue` | — | — | — | ✓ | `routes/admin.js:162` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts/:accountId/refresh` | — | — | — | ✓ | `routes/admin.js:149` | route-entry authorization |
| `POST /api/admin/baselinker-settings/accounts/:accountId/token` | — | — | — | ✓ | `routes/admin.js:137` | route-entry authorization |
| `POST /api/admin/baselinker-settings/validate` | — | — | — | ✓ | `routes/admin.js:76` | route-entry authorization |
| `POST /api/admin/cities` | — | — | — | ✓ | `routes/admin.js:338` | route-entry authorization |
| `POST /api/admin/openai/settings` | — | — | — | ✓ | `routes/admin.js:199` | route-entry authorization |
| `POST /api/admin/ordering-schedule` | — | — | — | ✓ | `routes/admin.js:298` | route-entry authorization |
| `POST /api/admin/price-groups` | — | — | — | ✓ | `routes/admin.js:707` | route-entry authorization |
| `POST /api/admin/supplement-settings` | — | — | — | ✓ | `routes/admin.js:320` | route-entry authorization |
| `POST /api/admin/telegram-groups` | — | — | — | ✓ | `routes/admin.js:452` | route-entry authorization |
| `POST /api/admin/telegram-groups/:groupId/check-all` | — | — | — | ✓ | `routes/admin.js:811` | route-entry authorization |
| `POST /api/admin/telegram-groups/:groupId/members/:telegramId/recheck` | — | — | — | ✓ | `routes/admin.js:794` | route-entry authorization |
| `POST /api/admin/telegram-member-tag-groups` | — | — | — | ✓ | `routes/admin.js:503` | route-entry authorization |
| `POST /api/admin/telegram-member-tags/reconcile` | — | — | — | ✓ | `routes/admin.js:551` | route-entry authorization |
| `POST /api/admin/telegram-new-products-bindings/:bindingId/identify` | — | — | — | ✓ | `routes/admin.js:661` | route-entry authorization |
| `POST /api/admin/telegram-new-products-bindings/:bindingId/resolve-absent` | — | — | — | ✓ | `routes/admin.js:650` | route-entry authorization |
| `POST /api/admin/telegram-new-products-cleanups/:cleanupId/resolve` | — | — | — | ✓ | `routes/admin.js:631` | route-entry authorization |
| `POST /api/admin/telegram-new-products-cleanups/:cleanupId/retry` | — | — | — | ✓ | `routes/admin.js:642` | route-entry authorization |
| `POST /api/admin/telegram-new-products-group` | — | — | — | ✓ | `routes/admin.js:617` | route-entry authorization |
| `POST /api/admin/telegram-support-admins` | — | — | — | ✓ | `routes/admin.js:569` | route-entry authorization |
| `POST /api/admin/vision-settings` | — | — | — | ✓ | `routes/admin.js:281` | route-entry authorization |
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
| `POST /api/commerce/catalog` | — | — | — | ✓ | `routes/commerce.js:114` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/catalog/import-warehouse` | — | — | — | ✓ | `routes/commerce.js:109` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/categories` | — | — | — | ✓ | `routes/commerce.js:87` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/providers/:provider/operations/:operation` | — | — | — | ✓ | `routes/commerce.js:38` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/activate` | — | — | — | ✓ | `routes/commerce.js:71` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/drafts` | — | — | — | ✓ | `routes/commerce.js:64` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/drafts/reconcile` | — | — | — | ✓ | `routes/commerce.js:66` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/drafts/status` | — | — | — | ✓ | `routes/commerce.js:65` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/health` | — | — | — | ✓ | `routes/commerce.js:80` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/lifecycle` | — | — | — | ✓ | `routes/commerce.js:79` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/lifecycle/preview` | — | — | — | ✓ | `routes/commerce.js:78` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/mapping/resolve` | — | — | — | ✓ | `routes/commerce.js:62` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/price-sync` | — | — | — | ✓ | `routes/commerce.js:75` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/price-sync/preview` | — | — | — | ✓ | `routes/commerce.js:74` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/sales-settings/apply` | — | — | — | ✓ | `routes/commerce.js:69` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/sales-settings/resolve` | — | — | — | ✓ | `routes/commerce.js:67` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/sales-settings/status` | — | — | — | ✓ | `routes/commerce.js:70` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/stock-sync` | — | — | — | ✓ | `routes/commerce.js:77` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/stock-sync/preview` | — | — | — | ✓ | `routes/commerce.js:76` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/update-content` | — | — | — | ✓ | `routes/commerce.js:73` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/allegro/update-preview` | — | — | — | ✓ | `routes/commerce.js:72` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/commerce/publications/preview` | — | — | — | ✓ | `routes/commerce.js:45` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `POST /api/delivery-groups` | — | — | — | ✓ | `routes/deliveryGroups.js:248` | route-entry authorization |
| `POST /api/delivery-groups/:id/broadcast` | — | — | — | ✓ | `routes/deliveryGroups.js:552` | route-entry authorization |
| `POST /api/delivery-groups/:id/close-ordering-session` | — | — | — | ✓ | `routes/deliveryGroups.js:152` | route-entry authorization |
| `POST /api/delivery-groups/catalog-reviewed` | — | ✓ | ✓ | ✓ | `routes/deliveryGroups.js:65` | route-entry authorization |
| `POST /api/invoices` | — | — | — | ✓ | `routes/invoices.js:527` | route-entry authorization |
| `POST /api/invoices/:id/corrections` | — | — | — | ✓ | `routes/invoices.js:556` | route-entry authorization |
| `POST /api/invoices/:id/finalize` | — | — | — | ✓ | `routes/invoices.js:666` | route-entry authorization |
| `POST /api/invoices/:id/fiscal/ksef/offline24/prepare` | — | — | — | ✓ | `routes/invoices.js:578` | route-entry authorization |
| `POST /api/invoices/:id/fiscal/ksef/reconcile` | — | — | — | ✓ | `routes/invoices.js:599` | route-entry authorization |
| `POST /api/invoices/:id/fiscal/ksef/submit` | — | — | — | ✓ | `routes/invoices.js:585` | route-entry authorization |
| `POST /api/invoices/:id/fiscal/ksef/technical-correction/prepare` | — | — | — | ✓ | `routes/invoices.js:563` | route-entry authorization |
| `POST /api/invoices/:id/fiscal/ksef/validate` | — | — | — | ✓ | `routes/invoices.js:570` | route-entry authorization |
| `POST /api/invoices/:id/source/refresh` | — | — | — | ✓ | `routes/invoices.js:657` | route-entry authorization |
| `POST /api/invoices/business-counterparties` | — | — | — | ✓ | `routes/invoices.js:340` | route-entry authorization |
| `POST /api/invoices/ksef/certificate-enrollments` | — | — | — | ✓ | `routes/invoices.js:278` | route-entry authorization |
| `POST /api/invoices/ksef/certificate-enrollments/:enrollmentId/reconcile` | — | — | — | ✓ | `routes/invoices.js:291` | route-entry authorization |
| `POST /api/invoices/ksef/certificates/:certificateSerialNumber/revoke` | — | — | — | ✓ | `routes/invoices.js:297` | route-entry authorization |
| `POST /api/invoices/ksef/connections` | — | — | — | ✓ | `routes/invoices.js:209` | route-entry authorization |
| `POST /api/invoices/ksef/connections/:connectionId/check` | — | — | — | ✓ | `routes/invoices.js:227` | route-entry authorization |
| `POST /api/invoices/ksef/connections/:connectionId/token` | — | — | — | ✓ | `routes/invoices.js:221` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-documents/:documentId/business-links/:linkId/reject` | — | — | — | ✓ | `routes/invoices.js:455` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-documents/:documentId/business-links/confirm` | — | — | — | ✓ | `routes/invoices.js:449` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-documents/:documentId/business-links/refresh` | — | — | — | ✓ | `routes/invoices.js:443` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-documents/:documentId/fetch` | — | — | — | ✓ | `routes/invoices.js:431` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-syncs` | — | — | — | ✓ | `routes/invoices.js:362` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-syncs/:syncId/export` | — | — | — | ✓ | `routes/invoices.js:405` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-syncs/:syncId/reset-cursor` | — | — | — | ✓ | `routes/invoices.js:380` | route-entry authorization |
| `POST /api/invoices/ksef/inbound-syncs/:syncId/run` | — | — | — | ✓ | `routes/invoices.js:374` | route-entry authorization |
| `POST /api/invoices/ksef/offline-certificates` | — | — | — | ✓ | `routes/invoices.js:320` | route-entry authorization |
| `POST /api/invoices/ksef/ops/cleanup` | — | — | — | ✓ | `routes/invoices.js:197` | route-entry authorization |
| `POST /api/invoices/ksef/ops/issues/:kind/:id/retry` | — | — | — | ✓ | `routes/invoices.js:170` | route-entry authorization |
| `POST /api/invoices/ksef/ops/probe` | — | — | — | ✓ | `routes/invoices.js:185` | route-entry authorization |
| `POST /api/invoices/ksef/ops/recover-stale-leases` | — | — | — | ✓ | `routes/invoices.js:191` | route-entry authorization |
| `POST /api/invoices/ksef/technical-corrections/:correctionId/reconcile` | — | — | — | ✓ | `routes/invoices.js:479` | route-entry authorization |
| `POST /api/invoices/ksef/technical-corrections/:correctionId/submit` | — | — | — | ✓ | `routes/invoices.js:472` | route-entry authorization |
| `POST /api/invoices/ksef/xades-credentials` | — | — | — | ✓ | `routes/invoices.js:243` | route-entry authorization |
| `POST /api/invoices/ksef/xades-credentials/:credentialId/check` | — | — | — | ✓ | `routes/invoices.js:255` | route-entry authorization |
| `POST /api/invoices/legal-entities` | — | — | — | ✓ | `routes/invoices.js:134` | route-entry authorization |
| `POST /api/invoices/preview` | — | — | — | ✓ | `routes/invoices.js:504` | route-entry authorization |
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
| `POST /api/products` | — | — | ✓ | ✓ | `routes/products.js:1409` | route-entry authorization |
| `POST /api/products/:id/describe` | — | — | ✓ | ✓ | `routes/products.js:1702` | route-entry authorization |
| `POST /api/products/ask-group-price` | — | ✓ | ✓ | ✓ | `routes/products.js:430` | route-entry authorization |
| `POST /api/products/block-upload-photos` | — | — | ✓ | ✓ | `routes/products.js:1247` | route-entry authorization |
| `POST /api/products/broadcast` | — | ✓ | ✓ | ✓ | `routes/products.js:990` | route-entry authorization |
| `POST /api/products/receive` | — | — | ✓ | ✓ | `routes/products.js:1343` | route-entry authorization |
| `POST /api/products/report-missing` | — | ✓ | ✓ | ✓ | `routes/products.js:1011` | route-entry authorization |
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
| `POST /api/shops` | — | — | — | ✓ | `routes/shops.js:305` | route entry only; response projection may vary by role |
| `POST /api/shops/:id/invite-link` | — | — | — | ✓ | `routes/shops.js:502` | route entry only; response projection may vary by role |
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
| `POST /api/users` | — | — | — | ✓ | `routes/users.js:162` | route-entry authorization |
| `POST /api/users/:telegramId/cleared-carts/:cartId/restore` | — | — | — | ✓ | `routes/users.js:155` | route-entry authorization |
| `POST /api/v1/auth/google` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:131` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
| `POST /api/v1/auth/google/link/bootstrap` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:153` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
| `POST /api/v1/auth/google/link/complete` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:173` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
| `POST /api/v1/auth/logout` | — | ✓ | ✓ | ✓ | `routes/v1/auth.js:255` | first-party session proof required before route; pre-registration/browser probe path |
| `POST /api/v1/auth/telegram/bootstrap` | ✓ | ✓ | ✓ | ✓ | `routes/v1/auth.js:87` | explicit auth/check entry; route-specific credential/state/rate limits may still apply |
| `POST /api/v1/orders` | — | ✓ | ✓ | ✓ | `routes/orders.js:724` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/:id/fulfill` | — | — | ✓ | ✓ | `routes/orders.js:691` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/:id/stale/expire` | — | — | — | ✓ | `routes/orders.js:1643` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/:id/stale/restore-to-cart` | — | — | — | ✓ | `routes/orders.js:1409` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/conflicts/resolve` | — | — | ✓ | ✓ | `routes/orders.js:419` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/remove-item` | — | ✓ | ✓ | ✓ | `routes/orders.js:1984` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/set-item-qty` | — | ✓ | ✓ | ✓ | `routes/orders.js:1911` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/orders/upsert-item` | — | ✓ | ✓ | ✓ | `routes/orders.js:1707` | route entry only; ownership/shop/session checks run in handler |
| `POST /api/v1/products` | — | — | ✓ | ✓ | `routes/products.js:1409` | route-entry authorization |
| `POST /api/v1/products/:id/describe` | — | — | ✓ | ✓ | `routes/products.js:1702` | route-entry authorization |
| `POST /api/v1/products/ask-group-price` | — | ✓ | ✓ | ✓ | `routes/products.js:430` | route-entry authorization |
| `POST /api/v1/products/block-upload-photos` | — | — | ✓ | ✓ | `routes/products.js:1247` | route-entry authorization |
| `POST /api/v1/products/broadcast` | — | ✓ | ✓ | ✓ | `routes/products.js:990` | route-entry authorization |
| `POST /api/v1/products/receive` | — | — | ✓ | ✓ | `routes/products.js:1343` | route-entry authorization |
| `POST /api/v1/products/report-missing` | — | ✓ | ✓ | ✓ | `routes/products.js:1011` | route-entry authorization |
| `POST /api/v1/telegram/google/link/start` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:357` | route-entry authorization |
| `POST /api/v1/telegram/google/unlink` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:369` | route-entry authorization |
| `POST /api/v1/telegram/me` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:223` | first-party session proof required before route; pre-registration/browser probe path |
| `POST /api/v1/telegram/mini-app/reset-state` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:516` | route-entry authorization |
| `POST /api/v1/telegram/mini-app/state` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:395` | route-entry authorization |
| `POST /api/v1/telegram/register-request` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:628` | first-party session proof required before route; pre-registration/browser probe path |
| `POST /api/v1/telegram/register-requests/:id/approve` | — | — | — | ✓ | `routes/v1/telegram.js:812` | route-entry authorization |
| `POST /api/v1/telegram/register-requests/:id/block` | — | — | — | ✓ | `routes/v1/telegram.js:909` | route-entry authorization |
| `POST /api/v1/telegram/register-requests/:id/reject` | — | — | — | ✓ | `routes/v1/telegram.js:899` | route-entry authorization |
| `POST /api/v1/telegram/register-requests/:id/unblock` | — | — | — | ✓ | `routes/v1/telegram.js:919` | route-entry authorization |
| `POST /api/v1/telegram/registration-invite` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:556` | first-party session proof required before route; pre-registration/browser probe path |
| `POST /api/v1/telegram/validate` | — | ✓ | ✓ | ✓ | `routes/v1/telegram.js:217` | first-party session proof required before route; pre-registration/browser probe path |
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
| `POST /telegram-webhook/<token-derived-path>` | — | — | — | — | `app.js:73` | Telegram secret-token header + token-derived path; machine-authenticated, no app user role |
| `PUT /api/admin/openai-key` | — | — | — | ✓ | `routes/admin.js:430` | route-entry authorization |
| `PUT /api/commerce/publications/allegro/mapping` | — | — | — | ✓ | `routes/commerce.js:63` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |
| `PUT /api/commerce/publications/allegro/sales-settings` | — | — | — | ✓ | `routes/commerce.js:68` | provider-worker boundary; among these four roles only admin passes (baselinker is outside the table) |

## Coverage contract

Run `npm run test:security:endpoint-matrix`. The check re-scans every `app.METHOD` and `router.METHOD` declaration,
rebuilds this table, and fails if a route, mount, role guard, or source line changes without an explicit review.

The conditional warehouse-test router/static UI are included even though production cannot mount them. The Telegram
webhook and Print Agent endpoints are listed, but their non-user credentials are intentionally not treated as user roles.
The separate `baselinker` provider-worker role is deliberately outside this requested four-role table.
