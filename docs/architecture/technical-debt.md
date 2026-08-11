# Технічний борг

## Відкладено за рішенням власника

### Каталоги товарів

У проєкті паралельно існують `Product`, `ShopProduct` і `SearchProduct`. Потрібно окремо дослідити відповідальність кожної сутності, перейменувати їх у зрозумілі терміни та прибрати зайві дзеркала. До цього завдання не торкатися структури без окремого плану міграції.

### Джерело групи доставки — ЗАКРИТО (07.08.2026)

Одне джерело істини: `User.shopId → Shop.deliveryGroupId → DeliveryGroup`.

`User.deliveryGroupId` і `User.warehouseZone` прибрані зі схеми й з бази
(`scripts/normalizeUserGroup.js`). Разом з ними зник каскад `User.updateMany` у
`routes/shops.js`, який тримав копії в актуальному стані й був єдиною причиною,
чому пропущений шлях зміни магазину міг залишити продавця в старій групі.

Похідні значення обчислюються в місці використання; API-контракт незмінний —
профіль `/v1/telegram` віддає `deliveryGroupId` + `warehouseZone`, список
користувачів — `shopDeliveryGroupId`.

НЕ плутати з `Order.buyerSnapshot.deliveryGroupId` і
`RegistrationRequest.deliveryGroupId`: це історичні знімки, вони canonical для
свого документа і залишаються.

### Стара логіка зміни складу — ЗАКРИТО (11.08.2026)

Legacy-модель `isOnShift` / `shiftZone` / `isWarehouseManager` і endpoints
`/api/warehouse/{shift-status,confirm-shift,close-shift,remove-from-shift}` видалені.
Вони могли глобально відпускати `PickingTask` без `orderingSessionId` і тому суперечили
session-isolation контракту.

Актуальна сторінка «Зміна» НЕ є цією legacy-моделлю: вона працює через
`/api/picking/shift-board` і залишається чинною.

### Дозамовлення

На майбутнє відкладені:

- фактичний залишок і резервування;
- OOS і часткове виконання;
- адміністративне скасування;
- окремі Telegram-групи для безпеки та службових повідомлень.
