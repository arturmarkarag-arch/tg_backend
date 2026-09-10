Telegram member shop tags — patch 2026-09-10

TYPE: manual file replacement patch. Do NOT install this ZIP as an application/package.
BASE: current ERP frontend/backend after the Sentry patch from this chat.

BACKEND local steps after copying files:
  cd <backend>
  npm install node-telegram-bot-api@0.68.0 --save-exact
  npm run test:telegram-member-tags

Recommended existing regression gates:
  npm run test:baselinker:architecture
  npm run test:baselinker:lifecycle
  npm run test:baselinker:efficiency

FRONTEND local steps after copying files:
  cd <frontend>
  npm install
  npm run test:telegram-member-tags
  npm run build

Telegram configuration:
1. Bot must be administrator in the MAIN group.
2. Bot must have can_manage_tags=true. No extra rights are required by this feature.
3. In ERP Settings -> Telegram groups, ensure the group is in allowed groups and select it as MAIN.
4. Open "Плашки магазинів" health. It must report the configured MAIN group and can_manage_tags=true.
5. Press "Синхронізувати всіх" once after first deploy.

Expected behavior:
- regular member + shop => #ShopName
- regular member + no shop => tag cleared
- administrator / creator => never touched
- restricted/non-member => skipped by explicit policy
- tag max 16 Unicode code points including #; emoji => invalid_tag, no heuristic rewrite
- repeated desired==actual => no Telegram write
- only explicit MAIN group is managed
- durable queue + revision guard + lease recovery + bounded retry
- dedicated scheduler leader; reconcile cannot block Telegram notification delivery
- shop assignment/unassignment and shop rename enqueue only affected ERP users
- chat_member changes in MAIN enqueue only the affected Telegram user
- manual reconcile iterates ERP users, never scans all Telegram members
- main-group migration cleans an old tag only when it still equals the ERP-managed tag; admins/manual-changed tags remain untouched

Important:
- package-lock.json is intentionally NOT included. The npm install command above updates it correctly on your machine.
- Do not upgrade node-telegram-bot-api to v2 as part of this patch; that is a separate migration.
