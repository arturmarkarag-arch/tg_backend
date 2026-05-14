/**
 * Centralised error handling for the API.
 *
 * Goal: every HTTP response with an error must have:
 *   - a stable machine-readable `error` code (snake_case),
 *   - a human-readable Ukrainian `message` (already localised on the server),
 *   - the correct HTTP `status`.
 *
 * Usage in handlers:
 *
 *   const { appError } = require('../utils/errors');
 *
 *   if (!receipt) throw appError('receipt_not_found');
 *   if (active > 0) throw appError('user_has_active_work', { activeOrders, activePickingTasks });
 *
 * Pair with `asyncHandler` (see below) and the `errorHandler` middleware in app.js
 * so thrown errors are converted into properly-formatted JSON responses.
 */

// ─── Dictionary ──────────────────────────────────────────────────────────────
// Each entry: { status, message } where message is either a string or a function(args) → string.
// IMPORTANT: keep messages in Ukrainian. New error codes go here, not inline.
const ERRORS = {
  // ── Generic ────────────────────────────────────────────────────────────────
  internal_error:           { status: 500, message: 'Внутрішня помилка сервера' },
  lock_busy:                { status: 409, message: ({ resource } = {}) => resource
                                ? `Ресурс «${resource}» зараз змінюється іншим користувачем. Спробуйте ще раз за кілька секунд.`
                                : 'Ресурс зараз змінюється іншим користувачем. Спробуйте ще раз за кілька секунд.' },
  validation_failed:        { status: 400, message: ({ field } = {}) => field
                                ? `Невалідне значення поля «${field}»`
                                : 'Невалідні дані запиту' },
  not_found:                { status: 404, message: 'Не знайдено' },
  forbidden:                { status: 403, message: 'Недостатньо прав для цієї дії' },
  unauthenticated:          { status: 401, message: 'Потрібна авторизація' },

  // ── Receipts ───────────────────────────────────────────────────────────────
  receipt_not_found:        { status: 404, message: 'Накладну не знайдено' },
  receipt_already_completed:{ status: 409, message: 'Накладну вже проведено' },
  receipt_no_items:         { status: 400, message: 'У накладній немає позицій' },
  receipt_items_incomplete: { status: 400, message: 'Не всі товари повністю описані' },
  receipt_item_pending:     { status: 422, message: ({ name } = {}) =>
                                `Позиція "${name || 'без назви'}" ще не прив'язана до складу. Знайдіть товар або оформіть як новий.` },
  receipt_item_orphan_transit: { status: 422, message: ({ name, transitQty } = {}) =>
                                `Позиція "${name || 'без назви'}" має транзит ${transitQty} шт, але групи доставки не вказані` },
  receipt_completed_locked: { status: 409, message: 'Накладну вже проведено — редагування неможливе' },
  receipt_completed_no_delete: { status: 409, message: 'Не можна видаляти позиції з проведеної накладної' },
  receipt_item_not_found:   { status: 404, message: 'Позицію не знайдено' },
  receipt_save_failed:      { status: 500, message: 'Не вдалося оновити позицію' },
  receipt_commit_failed:    { status: 500, message: 'Не вдалося провести накладну' },
  receipt_delete_item_failed:{ status: 500, message: 'Не вдалося видалити позицію' },

  // ── Users ──────────────────────────────────────────────────────────────────
  user_not_found:           { status: 404, message: 'Користувача не знайдено' },
  user_telegram_id_taken:   { status: 409, message: ({ telegramId } = {}) =>
                                `Користувач з Telegram ID ${telegramId || ''} вже існує. Оновіть сторінку і повторіть.` },
  user_create_failed:       { status: 500, message: 'Не вдалося створити користувача' },
  user_has_active_work:     { status: 409, message: ({ activeOrders = 0, activePickingTasks = 0 } = {}) =>
                                `Не можна видалити користувача: ${activeOrders} активне замовлення, ${activePickingTasks} активний пакувальний таск. Спочатку завершіть або скасуйте їх.` },

  // ── Shops ──────────────────────────────────────────────────────────────────
  shop_not_found:           { status: 404, message: 'Магазин не знайдено' },
  shop_has_sellers:         { status: 400, message: ({ sellerCount } = {}) =>
                                `Не можна видалити магазин: ${sellerCount} продавець(ів) прив'язано. Спочатку зніміть їх у налаштуваннях магазину.` },
  shop_has_active_orders:   { status: 409, message: ({ activeOrders } = {}) =>
                                `Не можна видалити магазин: ${activeOrders} активне замовлення прив'язано. Спочатку завершіть або скасуйте їх.` },
  shop_sellers_invalid:     { status: 400, message: ({ ids = [] } = {}) =>
                                `Продавців не знайдено: ${Array.isArray(ids) ? ids.join(', ') : ids}` },

  // ── Delivery groups ────────────────────────────────────────────────────────
  group_not_found:          { status: 404, message: 'Групу доставки не знайдено' },
  group_has_shops:          { status: 400, message: ({ shopCount } = {}) =>
                                `Не можна видалити групу: ${shopCount} магазин(ів) прив'язано (включно з неактивними).` },
  group_has_active_orders:  { status: 409, message: ({ activeOrders } = {}) =>
                                `Не можна видалити групу: ${activeOrders} активне замовлення прив'язано.` },

  // ── Cities ─────────────────────────────────────────────────────────────────
  city_not_found:           { status: 404, message: 'Місто не знайдено' },
  city_has_shops:           { status: 400, message: ({ shopCount } = {}) =>
                                `Не можна видалити: ${shopCount} магазин(ів) прив'язано до цього міста` },

  // ── Blocks ─────────────────────────────────────────────────────────────────
  block_not_found:          { status: 404, message: 'Блок не знайдено' },
  block_invalid_number:     { status: 400, message: 'Невірний номер блока' },
  block_missing_product_id: { status: 400, message: 'Не вказано productId' },
  block_invalid_product_id: { status: 400, message: 'productId має невірний формат' },
  block_stale:              { status: 409, message: ({ currentVersion } = {}) =>
                                `Блок змінив інший користувач${currentVersion != null ? ` (актуальна версія: ${currentVersion})` : ''}. Оновіть сторінку і повторіть.` },
  product_already_in_block: { status: 409, message: ({ existingBlockId } = {}) =>
                                `Товар вже у цьому блоці${existingBlockId != null ? ` (#${existingBlockId})` : ''}` },
  product_in_other_block:   { status: 409, message: ({ existingBlockId } = {}) =>
                                `Товар вже у блоці #${existingBlockId}` },
  product_not_in_block:     { status: 404, message: 'Товар не у цьому блоці' },
  product_not_in_source_block:{ status: 400, message: 'Товар не у вихідному блоці' },
  block_move_invalid_fields:{ status: 400, message: 'Невалідні параметри переносу: productId, fromBlock, toBlock, toIndex' },
  block_concurrent_modification: { status: 409, message: 'Блок змінюється кількома користувачами одночасно. Спробуйте ще раз.' },

  // ── Orders ─────────────────────────────────────────────────────────────────
  order_not_found:          { status: 404, message: 'Замовлення не знайдено' },
  order_not_active:         { status: 409, message: ({ status } = {}) =>
                                `Замовлення вже ${status === 'fulfilled' ? 'виконано' : 'скасовано'} — перенос неможливий.` },
  order_picking_started:    { status: 409, message: 'Замовлення вже в роботі на складі (пакування розпочато або підготовлено). Перенос/відв’язка заборонені.' },
  order_picking_locked:     { status: 409, message: 'Замовлення зараз у активному пакуванні на складі. Дочекайтесь розблокування або підтвердження від складу.' },
  order_status_change_disabled: { status: 403, message: 'Ручна зміна статусу замовлення вимкнена. Статус змінюється лише автоматично під час збирання.' },

  // ── Cart (mini-app) ────────────────────────────────────────────────────────
  cart_stale:               { status: 409, message: 'Кошик було змінено з іншого пристрою. Перевірте склад і повторіть.' },

  // ── Auth / middleware ─────────────────────────────────────────────────────
  auth_invalid_init_data:   { status: 401, message: ({ reason } = {}) => reason
                                ? `Невалідні дані Telegram: ${reason}`
                                : 'Невалідні дані авторизації Telegram' },
  auth_telegram_id_missing: { status: 400, message: 'Не передано Telegram user id' },
  auth_not_registered:      { status: 403, message: 'Користувача не зареєстровано' },
  // Backwards-compat alias used by mini-app client code that switches on `error` value.
  not_registered:           { status: 403, message: 'Користувача не зареєстровано' },
  auth_required:            { status: 401, message: 'Потрібна авторизація через Telegram' },
  auth_role_required:       { status: 403, message: ({ allowed = [] } = {}) =>
                                `Доступ заборонено. Дозволено лише: ${(Array.isArray(allowed) ? allowed : [allowed]).join(', ')}` },

  // ── Users (extra) ──────────────────────────────────────────────────────────
  user_fetch_failed:        { status: 500, message: 'Не вдалося отримати список користувачів' },
  user_update_failed:       { status: 500, message: 'Не вдалося оновити дані користувача' },
  user_shop_update_failed:  { status: 500, message: 'Не вдалося оновити прив\u02bcязку магазину' },

  // ── Products ───────────────────────────────────────────────────────────────
  product_not_found:        { status: 404, message: 'Товар не знайдено' },
  product_image_unsupported:{ status: 400, message: 'Непідтримуваний формат зображення' },
  product_image_not_found:  { status: 404, message: 'Зображення не знайдено' },
  product_upload_failed:    { status: 500, message: 'Не вдалося завантажити файл' },
  product_drafts_failed:    { status: 500, message: 'Не вдалося отримати чернетки' },
  product_list_failed:      { status: 500, message: 'Не вдалося отримати список товарів' },
  product_barcode_required: { status: 400, message: 'Параметр barcode обовʼязковий' },
  product_filename_required:{ status: 400, message: 'Параметр filename обовʼязковий' },
  product_reorder_invalid:  { status: 400, message: 'Order має бути масивом id товарів' },
  product_broadcast_invalid:{ status: 400, message: 'productIds має бути непорожнім масивом' },
  product_only_archived_can_delete:{ status: 400, message: 'Видаляти можна лише товари зі статусом «архів»' },
  product_not_archived:     { status: 400, message: 'Товар не знаходиться в архіві' },
  product_photo_required:   { status: 400, message: 'Фото є обов\u02bcязковим' },
  product_quantity_invalid: { status: 400, message: 'Кількість має бути цілим числом >= 0' },
  product_required_fields:  { status: 400, message: 'Порядковий номер, ціна та кількість є обов\u02bcязковими' },
  product_order_invalid:    { status: 400, message: 'Порядковий номер має бути цілим числом більше за 0' },
  product_archive_via_delete:{ status: 400, message: 'Використовуйте DELETE для архівації товару' },
  product_block_id_invalid: { status: 400, message: 'Невірний ідентифікатор блока' },
  product_filenames_required:{ status: 400, message: 'Не вказано файли зображень' },
  product_upload_failed_generic: { status: 500, message: 'Не вдалося завантажити' },
  telegram_groups_not_configured: { status: 500, message: 'Не налаштовано Telegram-групи для розсилок' },
  telegram_bot_not_initialized:   { status: 500, message: 'Telegram-бот не ініціалізований' },
  search_r2_public_url_missing:   { status: 503, message: 'R2_PUBLIC_URL не сконфігуровано' },
  search_no_existing_request:     { status: 404, message: 'Запит для цього штрихкоду не знайдено' },
  search_resend_rate_limited:     { status: 429, message: 'Забагато повторних запитів для цього штрихкоду. Спробуйте пізніше' },
  search_resend_failed:           { status: 500, message: 'Не вдалося повторно надіслати запит' },
  // ── Warehouse / Shifts ─────────────────────────────────────────────────────
  warehouse_worker_id_required:   { status: 400, message: 'workerId є обовʼязковим' },
  warehouse_worker_not_found:     { status: 404, message: 'Складського працівника не знайдено' },
  warehouse_remove_failed:        { status: 500, message: 'Не вдалося зняти працівника зі зміни' },
  warehouse_only_manager_confirm: { status: 403, message: 'Підтверджувати зміну можуть лише менеджери складу або адмін' },
  warehouse_workerids_required:   { status: 400, message: 'workerIds має бути непорожнім масивом' },
  warehouse_workerids_invalid:    { status: 400, message: 'Невірні workerIds' },
  warehouse_no_matching_workers:  { status: 404, message: 'Не знайдено жодного складського працівника' },
  warehouse_no_blocks:            { status: 400, message: 'Не визначено жодного блока на складі' },
  warehouse_insufficient_blocks:  { status: 400, message: 'Недостатньо блоків для розподілу між обраними працівниками' },
  warehouse_only_manager_close:   { status: 403, message: 'Закривати зміну можуть лише менеджери складу або адмін' },
  // ── Picking ────────────────────────────────────────────────────────────────
  picking_task_not_found:         { status: 404, message: 'Завдання не знайдено' },
  picking_product_not_found:      { status: 404, message: 'Товар не знайдено' },
  picking_current_block_invalid:  { status: 400, message: 'currentBlock має бути додатнім цілим числом' },
  picking_block_invalid:          { status: 400, message: 'blockId має бути додатнім цілим числом' },
  picking_delivery_group_required:{ status: 400, message: 'Для старту сесії збирання потрібно передати deliveryGroupId' },
  picking_session_failed:         { status: 500, message: 'Помилка запуску сесії збирання' },
  picking_next_failed:            { status: 500, message: 'Помилка отримання задачі' },
  picking_block_tasks_failed:     { status: 500, message: 'Помилка отримання задач блоку' },
  picking_complete_failed:        { status: 500, message: 'Помилка завершення задачі' },
  picking_progress_failed:        { status: 500, message: 'Помилка збереження прогресу' },
  picking_claim_unavailable:      { status: 409, message: 'Завдання більше недоступне' },
  picking_claim_taken_by_other:   { status: 409, message: 'Завдання забрав інший складник' },
  picking_claim_failed:           { status: 500, message: 'Помилка призначення задачі' },
  picking_oos_failed:             { status: 500, message: 'Помилка запису «немає на складі»' },
  expired_lock:                   { status: 403, message: 'Завдання вже взяв інший складник або час блокування минув' },
  // ── Orders ─────────────────────────────────────────────────────────────────
  order_query_forbidden:          { status: 403, message: 'Ви можете запитувати лише власні замовлення' },
  order_not_found:                { status: 404, message: 'Замовлення не знайдено' },
  order_view_forbidden:           { status: 403, message: 'У вас немає доступу до цього замовлення' },
  order_modify_forbidden:         { status: 403, message: 'У вас немає прав змінювати це замовлення' },
  order_seller_no_status:         { status: 403, message: 'Продавці не можуть змінювати статус замовлення' },
  order_no_fields:                { status: 400, message: 'Немає коректних полів для оновлення' },
  order_invalid_initdata:         { status: 401, message: 'Некоректні або відсутні дані Telegram (initData)' },
  order_buyer_mismatch:           { status: 403, message: 'buyerTelegramId не збігається з автентифікованим користувачем' },
  order_items_required:           { status: 400, message: 'Потрібно передати коректний список товарів' },
  order_no_valid_items:           { status: 400, message: 'Не знайдено жодного коректного товару' },
  order_shop_required:            { status: 400, message: 'Не вказано shopId' },
  order_shop_not_found:           { status: 400, message: 'Магазин не знайдено' },
  order_transit_failed:           { status: 500, message: 'Не вдалося отримати замовлення в дорозі' },
  order_fulfill_failed:           { status: 500, message: 'Не вдалося завершити замовлення' },
  product_archive_failed:   { status: 500, message: 'Не вдалося архівувати товар' },
  product_restore_failed:   { status: 500, message: 'Не вдалося відновити товар' },

  // ── Receipts (extra) ───────────────────────────────────────────────────────
  receipt_fetch_failed:     { status: 500, message: 'Не вдалося отримати накладні' },
  receipt_only_draft_delete:{ status: 400, message: 'Видаляти можна лише чернетки накладних' },
  receipt_only_empty_delete:{ status: 400, message: 'Видаляти можна лише порожні накладні' },
  receipt_delete_failed:    { status: 500, message: 'Не вдалося видалити накладну' },
  receipt_create_failed:    { status: 500, message: 'Не вдалося створити накладну' },
  receipt_number_exists:    { status: 409, message: 'Накладна з таким номером вже існує' },
  receipt_multipart_required:{ status: 400, message: 'Очікується multipart/form-data' },
  receipt_invalid_delivery_groups:{ status: 400, message: 'Невірний формат deliveryGroupIds' },
  receipt_delivery_groups_missing:{ status: 400, message: 'Деякі deliveryGroupIds не існують' },
  receipt_photo_required:   { status: 400, message: 'Потрібно прикріпити фото для нового товару' },
  receipt_add_item_failed:  { status: 500, message: 'Не вдалося додати позицію' },
  receipt_items_fetch_failed:{ status: 500, message: 'Не вдалося отримати позиції накладної' },
  receipt_item_link_failed: { status: 500, message: 'Не вдалося прив\u02bcязати позицію' },
  receipt_log_fetch_failed: { status: 500, message: 'Не вдалося отримати журнал' },
  receipt_log_failed:       { status: 500, message: 'Не вдалося записати лог' },
  receipt_qty_invalid:      { status: 400, message: 'Загальна кількість має бути додатнім цілим числом' },
  receipt_transit_exceeds_total: { status: 400, message: 'Кількість в магазини не може перевищувати загальну' },
  receipt_log_action_required: { status: 400, message: 'Поле action обовʼязкове' },

  // ── Blocks (extra) ─────────────────────────────────────────────────────────
  block_id_conflict:        { status: 409, message: 'Конфлікт ID блока, повторіть спробу' },
  block_create_failed:      { status: 500, message: 'Не вдалося створити блок' },
  block_list_failed:        { status: 500, message: 'Не вдалося отримати список блоків' },
  block_fetch_failed:       { status: 500, message: 'Не вдалося отримати блок' },
  block_search_query_required:{ status: 400, message: 'Не вказано пошуковий запит' },

  // ── Admin / OpenAI / cities ────────────────────────────────────────────────
  openai_connection_failed: { status: 500, message: ({ reason } = {}) => reason
                                ? `Не вдалося підключитися до OpenAI: ${reason}`
                                : 'Не вдалося підключитися до OpenAI' },
  openai_models_failed:     { status: 500, message: 'Не вдалося отримати список моделей OpenAI' },
  me_shop_required:         { status: 400, message: 'shopId є обовʼязковим' },
  me_state_invalid_index:   { status: 400, message: ({ field } = {}) =>
                                `Поле «${field || 'currentIndex'}» має бути цілим невідʼємним числом` },
  init_data_required:       { status: 400, message: 'Відсутні дані Telegram (initData)' },
  registration_pending:     { status: 403, message: 'Ваша заявка на реєстрацію очікує підтвердження адміністратора' },
  registration_blocked:     { status: 403, message: 'Ваша реєстрація заблокована. Зверніться до адміністратора.' },
  registration_rejected:    { status: 403, message: 'Вашу заявку було відхилено. Ви можете надіслати нову заявку.' },
  registration_required_fields: { status: 400, message: 'Будь ласка, заповніть всі обовʼязкові поля' },
  registration_invalid_role:{ status: 400, message: 'Невірно вибрана роль' },
  registration_seller_shop_required: { status: 400, message: 'Магазин є обовʼязковим для продавця' },
  registration_shop_inactive: { status: 400, message: 'Магазин не знайдено або він неактивний' },
  registration_shop_no_group: { status: 400, message: 'Магазин не привʼязаний до групи доставки' },
  registration_group_not_found: { status: 400, message: 'Групу доставки магазину не знайдено' },
  registration_request_exists: { status: 409, message: 'У вас вже є активна заявка на реєстрацію' },
  registration_user_exists: { status: 409, message: 'Користувач уже зареєстрований у системі' },
  registration_not_found:   { status: 404, message: 'Заявку на реєстрацію не знайдено' },
  registration_not_pending: { status: 409, message: 'Заявка вже оброблена (схвалена/відхилена/заблокована)' },
  registration_status_invalid: { status: 400, message: 'Невірний фільтр статусу заявок' },
  registration_role_missing:{ status: 400, message: 'У заявці відсутня роль користувача' },
  registration_group_missing:{ status: 400, message: 'У заявці продавця відсутня група доставки' },
  openai_settings_read_failed:{ status: 500, message: 'Не вдалося прочитати налаштування OpenAI' },
  openai_settings_save_failed:{ status: 500, message: 'Не вдалося зберегти налаштування OpenAI' },
  openai_model_required:    { status: 400, message: 'Поле model обовʼязкове' },
  openai_model_unknown:     { status: 400, message: 'Невідома або непідтримувана модель' },
  schedule_read_failed:     { status: 500, message: 'Не вдалося прочитати графік прийому замовлень' },
  schedule_invalid:         { status: 400, message: ({ reason } = {}) => reason || 'Невалідні дані графіка' },
  schedule_zero_duration:   { status: 400, message: 'Час відкриття і закриття не можуть співпадати' },
  city_list_failed:         { status: 500, message: 'Не вдалося отримати список міст' },
  city_name_required:       { status: 400, message: 'Поле name обовʼязкове' },
  city_already_exists:      { status: 409, message: ({ name } = {}) => `Місто "${name || ''}" вже існує` },
  city_create_failed:       { status: 500, message: 'Не вдалося створити місто' },

  // ── Shop Transfer Requests ─────────────────────────────────────────────────
  transfer_shop_required:       { status: 400, message: 'Не вказано цільовий магазин (toShopId)' },
  transfer_no_source_shop:      { status: 400, message: 'Ви не прив\'язані до жодного магазину' },
  transfer_same_shop:           { status: 400, message: 'Цільовий магазин збігається з поточним' },
  transfer_target_not_found:    { status: 404, message: 'Цільовий магазин не знайдено або неактивний' },
  transfer_already_pending:     { status: 409, message: 'У вас вже є активний запит на зміну магазину. Скасуйте його перед створенням нового.' },
  transfer_not_found:           { status: 404, message: 'Запит на зміну магазину не знайдено' },
  transfer_not_pending:         { status: 409, message: 'Запит вже оброблений (схвалений/відхилений/скасований)' },
  transfer_seller_moved:        { status: 409, message: 'Продавець вже змінив магазин поки запит очікував' },
  transfer_target_occupied:     { status: 409, message: 'Цільовий магазин вже зайнятий іншим продавцем' },
  transfer_cart_decision_required: { status: 400, message: 'Необхідно вказати рішення щодо кошика (cartDecision: "clear" або "keep")' },

  // ── Shops (extra) ──────────────────────────────────────────────────────────
  shop_list_failed:         { status: 500, message: 'Не вдалося отримати список магазинів' },
  shop_cities_failed:       { status: 500, message: 'Не вдалося отримати список міст' },
  shop_fetch_failed:        { status: 500, message: 'Не вдалося отримати магазин' },
  shop_name_required:       { status: 400, message: 'name є обовʼязковим' },
  shop_city_required:       { status: 400, message: 'cityId є обовʼязковим' },
  shop_delivery_group_required:{ status: 400, message: 'deliveryGroupId є обовʼязковим' },
  shop_city_not_found:      { status: 400, message: 'Місто не знайдено' },
  shop_delivery_group_not_found:{ status: 400, message: 'Групу доставки не знайдено' },
  shop_create_failed:       { status: 500, message: 'Не вдалося створити магазин' },
  shop_update_failed:       { status: 500, message: 'Не вдалося оновити магазин' },

  // ── Delivery groups (extra) ────────────────────────────────────────────────
  group_name_or_day_required:{ status: 400, message: 'Поля name та dayOfWeek обовʼязкові' },
  group_no_members:         { status: 400, message: 'Група не має учасників' },
  group_broadcast_failed:   { status: 500, message: 'Не вдалося надіслати розсилку' },
};

// ─── AppError ────────────────────────────────────────────────────────────────
class AppError extends Error {
  constructor(code, args = {}) {
    const entry = ERRORS[code] || ERRORS.internal_error;
    const message = typeof entry.message === 'function' ? entry.message(args) : entry.message;
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = entry.status;
    this.args = args;
    this.expose = true; // safe to send to client
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.args };
  }
}

/**
 * Factory — preferred over `new AppError(...)`.
 * Optional `statusOverride` lets callers customise status without adding a new code.
 */
function appError(code, args = {}, statusOverride = null) {
  const err = new AppError(code, args);
  if (statusOverride) err.status = statusOverride;
  return err;
}

/**
 * Translate a code into a localised message. Useful when the caller needs
 * the message string but not the throw mechanics.
 */
function t(code, args = {}) {
  const entry = ERRORS[code] || ERRORS.internal_error;
  return typeof entry.message === 'function' ? entry.message(args) : entry.message;
}

/**
 * Wrap an async route handler so thrown errors propagate to Express's
 * error-handler middleware instead of crashing the process or leaking
 * raw stack traces. Use everywhere new code is added.
 *
 *   router.post('/x', asyncHandler(async (req, res) => { ... }));
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Express error-handler middleware. Mounted last in app.js.
 * - AppError → JSON with code+message+status, no stack.
 * - everything else → 500 with a generic Ukrainian message; details only in logs.
 */
// eslint-disable-next-line no-unused-vars -- 4-arg signature is required by Express
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err && err.name === 'AppError' && err.expose) {
    return res.status(err.status || 500).json(err.toJSON());
  }

  // Mongoose validation
  if (err && err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'validation_failed',
      message: t('validation_failed'),
      details: err.message,
    });
  }
  // Mongoose cast (bad ObjectId etc.)
  if (err && err.name === 'CastError') {
    return res.status(400).json({
      error: 'validation_failed',
      message: t('validation_failed', { field: err.path }),
    });
  }
  // Duplicate key — surface a generic conflict; specific routes can throw their own appError earlier.
  if (err && err.code === 11000) {
    return res.status(409).json({
      error: 'duplicate_key',
      message: 'Запис з такими даними вже існує',
    });
  }

  console.error('[errorHandler] unhandled:', err);
  return res.status(500).json({
    error: 'internal_error',
    message: t('internal_error'),
  });
}

module.exports = { AppError, appError, t, asyncHandler, errorHandler, ERRORS };
