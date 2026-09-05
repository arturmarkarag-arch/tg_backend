USER DIRECTORY — 2026-09-05

Виправлення поверх наданих client(20260905-single-problem-badge)(1).zip
та server(20260905-workflow-stage-cache-fix)(1).zip.

Повні архіви: client-20260905-user-directory.zip, server-20260905-user-directory.zip.
Патч: patch-20260905-user-directory.zip — ЛИШЕ для ручної заміни змінених файлів.
Папки client/ і server/ у патчі відповідають кореням ваших проєктів.

Спочатку оновіть і перезапустіть сервер, потім зберіть клієнт (npm run build)
із чинними змінними оточення. Залежності та lock-файли не оновлені.

Глобальний список 500 продавців прибрано; призначені й кандидати розділені.
Старе фіктивне відновлення ClearedCart вимкнено, історію збережено.
Фізичне очищення бази не виконувалося та не потрібне для роботи нових DTO.

Повний опис: docs/changes/2026-09-05-user-directory.md.
Перевірки: нові 32/32; build і runtime safety PASS.
Старі регресійні набори мають падіння, відтворені також у вихідних архівах.
Віддалені Mongo/live-gate перевірки не запускалися.

RELEASE-TAIL FOLLOW-UP — 05.09.2026

Цей архів ЗАМІНЮЄ попередній patch-20260905-user-directory.zip і так само
накладається поверх початкових client(20260905-single-problem-badge)(1).zip та
server(20260905-workflow-stage-cache-fix)(1).zip. Окремо старий патч перед ним
накладати не потрібно.

Додатково закрито хвости нового cartState/transfer контракту:
- wipeOrderCycle.js і preprodWipe.js більше не створюють orderItems,
  orderItemIds, lastOrderPositions, lastViewedOrderNumber або currentPage;
- liveOrderPickingE2E.js перевіряє сумісність старого payload без повернення
  legacy полів у канонічний cartState і без прихованого physical cleanup;
- warehouseTest.js більше не створює retired cart/displacement snapshot fields;
- checkOrderCycleLeftovers.js показує старі cartState поля саме як legacy residue;
- прибрано невикористаний transfer_cart_decision_required;
- додано read-only static gate: node scripts/checkUserDirectoryReleaseTails20260905.js.

Локально follow-up: static gate 44/44 PASS, node --check PASS. Повний Vitest
follow-up повторно не зараховано: встановлення залежностей у цьому середовищі
було перервано лімітом виконання. TEST Atlas/live gate не запускався.

