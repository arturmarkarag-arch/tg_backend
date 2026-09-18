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
  // ── Allegro ───────────────────────────────────────────────────────────────
  allegro_account_id_required: { status: 400, message: 'Не вказано Allegro-акаунт.' },
  allegro_account_not_found: { status: 404, message: 'Allegro-акаунт не знайдено.' },
  allegro_account_disabled: { status: 409, message: 'Allegro-акаунт вимкнений.' },
  allegro_account_name_required: { status: 400, message: 'Вкажіть нашу назву Allegro-акаунта.' },
  allegro_account_authorization_required: { status: 409, message: 'Спочатку авторизуйте цей Allegro-акаунт через OAuth.' },
  allegro_account_missing_required_scopes: { status: 409, message: ({ missingScopes = [] } = {}) => `Allegro-акаунт не має потрібних дозволів для роботи із замовленнями${Array.isArray(missingScopes) && missingScopes.length ? `: ${missingScopes.join(', ')}` : '.'}` },
  allegro_account_delete_requires_lifecycle: { status: 409, message: 'Підключений Allegro-акаунт не можна видалити без перевірки активних замовлень і черг.' },
  allegro_oauth_not_configured: { status: 503, message: ({ missing = [] } = {}) =>
                                `OAuth Allegro ще не налаштовано${Array.isArray(missing) && missing.length ? `: ${missing.join(', ')}` : '.'}` },
  allegro_config_secret_storage_not_configured: { status: 503, message: 'Сервер не має кореневого ключа для безпечного збереження секретів налаштувань. Налаштуйте APP_SETTINGS_ENCRYPTION_KEY або JWT_SECRET.' },
  allegro_config_secret_decrypt_failed: { status: 503, message: 'Не вдалося розшифрувати збережені секрети Allegro. Перевірте серверний кореневий ключ.' },
  allegro_config_client_id_required: { status: 400, message: 'Вкажіть Client ID застосунку Allegro.' },
  allegro_config_client_secret_required: { status: 400, message: 'Вкажіть Client Secret застосунку Allegro.' },
  allegro_config_redirect_uri_required: { status: 400, message: 'Вкажіть Redirect URI застосунку Allegro.' },
  allegro_config_redirect_uri_invalid: { status: 400, message: 'Redirect URI Allegro має бути повною HTTP(S)-адресою.' },
  allegro_config_user_agent_required: { status: 400, message: 'Вкажіть User-Agent застосунку Allegro.' },
  allegro_config_token_key_required: { status: 400, message: 'Вкажіть ключ шифрування Allegro-токенів.' },
  allegro_config_environment_locked: { status: 409, message: 'Не можна змінити Sandbox/Production після авторизації магазинів. Спочатку потрібна контрольована міграція або відключення всіх токенів.' },
  allegro_config_client_id_locked: { status: 409, message: 'Не можна змінити Client ID після авторизації магазинів без контрольованої міграції OAuth.' },
  allegro_config_token_key_locked: { status: 409, message: 'Не можна змінити ключ шифрування токенів після авторизації магазинів — чинні токени перестануть розшифровуватися.' },
  allegro_token_encryption_not_configured: { status: 503, message: 'Для Allegro ще не налаштовано ключ шифрування токенів.' },
  allegro_token_encrypt_failed: { status: 500, message: 'Не вдалося безпечно підготувати Allegro-токен до збереження.' },
  allegro_token_decrypt_failed: { status: 503, message: 'Не вдалося розшифрувати Allegro-токен. Перевірте ALLEGRO_TOKEN_ENCRYPTION_KEY на backend.' },
  allegro_oauth_state_invalid: { status: 400, message: 'Спроба підключення Allegro недійсна, вже використана або прострочена. Почніть підключення ще раз.' },
  allegro_oauth_code_required: { status: 400, message: 'Allegro не повернув код авторизації. Почніть підключення ще раз.' },
  allegro_oauth_exchange_failed: { status: 502, message: 'Allegro не прийняв код авторизації. Почніть підключення ще раз.' },
  allegro_oauth_refresh_failed: { status: 502, message: 'Не вдалося оновити авторизацію Allegro.' },
  allegro_oauth_token_response_invalid: { status: 502, message: 'Allegro повернув некоректну відповідь авторизації.' },
  allegro_access_token_missing: { status: 409, message: 'Для цього Allegro-акаунта немає access token. Підключіть акаунт знову.' },
  allegro_refresh_token_missing: { status: 409, message: 'Для цього Allegro-акаунта немає refresh token. Підключіть акаунт знову.' },
  allegro_identity_check_failed: { status: 502, message: 'Не вдалося перевірити Allegro-акаунт через GET /me.' },
  allegro_identity_response_invalid: { status: 502, message: 'Allegro не повернув коректну identity акаунта.' },
  allegro_oauth_identity_mismatch: { status: 409, message: ({ expectedLogin, receivedLogin } = {}) =>
                                `Цей локальний Allegro-акаунт уже належить іншому продавцю${expectedLogin ? ` (${expectedLogin})` : ''}${receivedLogin ? `. Ви авторизували ${receivedLogin}` : ''}. Для іншого продавця створіть окремий Allegro-акаунт.` },
  allegro_account_already_connected: { status: 409, message: ({ connectedAccountName } = {}) =>
                                `Цей реальний Allegro-акаунт уже підключено${connectedAccountName ? ` як «${connectedAccountName}»` : ''}.` },
  allegro_token_rotation_conflict: { status: 409, message: 'Токени Allegro вже оновив інший процес. Повторіть дію.' },
  allegro_upstream_timeout: { status: 504, message: 'Allegro не відповів вчасно.' },
  allegro_upstream_unavailable: { status: 503, message: 'Зараз немає зʼєднання з Allegro API.' },
  allegro_api_path_invalid: { status: 400, message: 'Некоректний шлях Allegro API.' },
  allegro_rate_budget_exhausted: { status: 503, message: 'Внутрішній ліміт запитів Allegro на цю хвилину вичерпано. Запит буде безпечно повторено пізніше.' },
  allegro_endpoint_rate_budget_exhausted: { status: 503, message: 'Ліміт цього ресурсу Allegro тимчасово вичерпано. Запит буде безпечно повторено пізніше.' },
  allegro_account_concurrency_exhausted: { status: 503, message: 'Для цього Allegro-акаунта вже виконується забагато паралельних запитів. Повторіть трохи пізніше.' },
  allegro_api_rate_limited: { status: 503, message: ({ userMessage } = {}) =>
                                userMessage || 'Allegro тимчасово обмежив частоту API-запитів. Повторимо після дозволеного інтервалу.' },
  allegro_api_authorization_lost: { status: 409, message: 'Allegro відхилив авторизацію навіть після оновлення токена. Перепідключіть цей Allegro-акаунт через OAuth.' },
  allegro_api_error: { status: 502, message: ({ userMessage, upstreamStatus } = {}) =>
                                userMessage || `Allegro API повернув помилку${upstreamStatus ? ` HTTP ${upstreamStatus}` : ''}.` },
  allegro_order_id_required: { status: 400, message: 'Не вказано ідентифікатор замовлення Allegro.' },
  allegro_order_not_found: { status: 404, message: 'Замовлення Allegro не знайдено у локальному індексі.' },
  allegro_order_response_invalid: { status: 502, message: 'Allegro повернув некоректні дані замовлення.' },
  allegro_order_bootstrap_too_large: { status: 409, message: ({ fulfillmentStatus } = {}) =>
                                `Початкова синхронізація Allegro перевищила безпечну межу${fulfillmentStatus ? ` для статусу ${fulfillmentStatus}` : ''}. Потрібна окрема контрольована міграція великої черги.` },
  allegro_order_not_found_upstream: { status: 409, message: 'Замовлення більше не доступне в Allegro. Локальний стан буде перевірено синхронізацією.' },
  allegro_order_cancelled: { status: 409, message: 'Замовлення анульовано в Allegro і більше не доступне для складської обробки.' },
  allegro_order_returned: { status: 409, message: 'Замовлення вже повернено в Allegro і не доступне для складської обробки.' },
  allegro_order_already_sent: { status: 409, message: 'Замовлення вже позначене як відправлене в Allegro.' },
  allegro_order_suspended: { status: 409, message: 'Виконання цього замовлення призупинене в Allegro.' },
  allegro_order_not_actionable: { status: 409, message: 'Поточний стан замовлення Allegro не дозволяє складську обробку.' },
  allegro_picking_not_started: { status: 409, message: 'Складську обробку цього Allegro-замовлення ще не розпочато.' },
  allegro_picking_not_owner: { status: 409, message: 'Це Allegro-замовлення зараз закріплене за іншим працівником.' },
  allegro_picking_taken: { status: 409, message: ({ ownerName } = {}) => `Allegro-замовлення вже в роботі${ownerName ? ` у ${ownerName}` : ''}.` },
  allegro_picking_stale: { status: 409, message: 'Стан Allegro-замовлення вже змінився. Дані оновлено — повторіть дію.' },
  allegro_picking_terminal: { status: 409, message: 'Це Allegro-замовлення вже завершене.' },
  allegro_picking_item_not_found: { status: 404, message: 'Позицію Allegro-замовлення не знайдено у складському snapshot.' },
  allegro_picking_item_state_invalid: { status: 400, message: 'Некоректний стан позиції Allegro-замовлення.' },
  allegro_picking_shortage_invalid: { status: 400, message: 'Для «Не вистачає» знайдена кількість має бути меншою за замовлену.' },
  allegro_picking_items_unhandled: { status: 409, message: 'Спочатку опрацюйте всі позиції Allegro-замовлення.' },
  allegro_picking_has_unresolved_issues: { status: 409, message: 'У замовленні залишилися невирішені проблемні позиції.' },
  allegro_picking_not_ready: { status: 409, message: 'Замовлення ще не готове до відправлення.' },
  allegro_upstream_review_required: { status: 409, message: 'Allegro змінив склад замовлення. Перевірте оновлення перед продовженням роботи.' },
  allegro_shipment_scope_required: { status: 409, message: ({ scope } = {}) => `Для роботи з ТТН перепідключіть Allegro OAuth із дозволом${scope ? ` ${scope}` : ' на shipment API'}.` },
  allegro_shipment_proposal_invalid: { status: 409, message: 'Allegro не повернув готові параметри відправлення. Перевірте налаштування «Wysyłam z Allegro» та адресу відправника.' },
  allegro_shipment_create_failed: { status: 409, message: ({ detail } = {}) => detail ? `Allegro не створив ТТН: ${detail}` : 'Allegro не створив ТТН.' },
  allegro_shipment_not_ready: { status: 409, message: 'ТТН Allegro ще не готова. Спочатку створіть відправлення.' },
  allegro_shipment_label_empty: { status: 502, message: 'Allegro не повернув файл етикетки для цього відправлення.' },
  marketplace_worker_has_active_order: { status: 409, message: ({ provider, orderId } = {}) => `У вас уже є активне замовлення${provider ? ` у ${provider}` : ''}${orderId ? ` №${orderId}` : ''}. Спочатку завершіть або відкладіть його.` },
  baselinker_queue_settings_invalid: { status: 400, message: 'Оберіть три різні статуси BaseLinker: вхідні, вислано та анульовано.' },
  baselinker_queue_status_unknown: { status: 400, message: 'Цього статусу більше немає в BaseLinker. Оновіть список і оберіть інший.' },
  baselinker_queue_not_configured: { status: 503, message: 'Робоча черга очікує налаштування трьох статусів BaseLinker.' },
  baselinker_account_disable_has_active_work: { status: 409, message: ({ intakeOrders = 0, unfinishedPicking = 0, activePrintJobs = 0 } = {}) =>
                                `Не можна вимкнути BaseLinker-акаунт: робочий цикл ще не завершений (у вхідній черзі: ${Number(intakeOrders) || 0}, незавершених локальних замовлень: ${Number(unfinishedPicking) || 0}, активних завдань друку: ${Number(activePrintJobs) || 0}). Спочатку завершіть або анулюйте всі замовлення.` },
  baselinker_lifecycle_reconciliation_incomplete: { status: 409, message: ({ departureVerificationPending = 0, trackedReverifyPending = 0 } = {}) => `Не вдалося повністю перевірити стан BaseLinker перед зміною налаштувань. Неперевірених виходів з Intake: ${departureVerificationPending}; tracked orders: ${trackedReverifyPending}. Повторіть синхронізацію.` },
  baselinker_queue_change_has_active_work: { status: 409, message: ({ intakeOrders = 0, unfinishedPicking = 0, activePrintJobs = 0 } = {}) =>
                                `Не можна змінити робочі статуси BaseLinker, поки триває виробничий цикл (у вхідній черзі: ${Number(intakeOrders) || 0}, незавершених локальних замовлень: ${Number(unfinishedPicking) || 0}, активних завдань друку: ${Number(activePrintJobs) || 0}).` },
  baselinker_queue_warming: { status: 503, message: 'Робоча черга оновлюється у фоні. Спробуйте знову трохи пізніше.' },
  // ── Generic ────────────────────────────────────────────────────────────────
  internal_error:           { status: 500, message: 'Внутрішня помилка сервера' },
  auth_rate_limited:        { status: 429, message: 'Забагато спроб авторизації. Зачекайте трохи та повторіть.' },
  api_rate_limited:         { status: 429, message: 'Забагато запитів. Зачекайте трохи та повторіть.' },
  auth_csrf_required:       { status: 403, message: 'Не вдалося підтвердити безпечне джерело запиту.' },
  lock_busy:                { status: 409, message: ({ resource } = {}) => resource
                                ? `Ресурс «${resource}» зараз змінюється іншим користувачем. Спробуйте ще раз за кілька секунд.`
                                : 'Ресурс зараз змінюється іншим користувачем. Спробуйте ще раз за кілька секунд.' },
  validation_failed:        { status: 400, message: ({ field } = {}) => field
                                ? `Невалідне значення поля «${field}»`
                                : 'Невалідні дані запиту' },
  invoice_not_found: { status: 404, message: 'Фактуру не знайдено.' },
  invoice_finalized_immutable: { status: 409, message: 'Фактуру вже фіналізовано. Історичний документ не можна змінювати; потрібен окремий документ/корекція.' },
  invoice_not_finalizable: { status: 409, message: ({ blockers = [] } = {}) => `Фактура ще не готова до фіналізації${Array.isArray(blockers) && blockers.length ? `: ${blockers.join(', ')}` : '.'}` },
  invoice_source_provider_not_supported: { status: 400, message: 'Invoice Source Provider не зареєстрований.' },
  invoice_source_entity_id_required: { status: 400, message: 'Не вказано ідентифікатор джерела фактури.' },
  invoice_source_quantity_mode_required: { status: 400, message: 'Для Warehouse Order треба явно вибрати quantityMode: ordered або fulfilled.' },
  invoice_source_account_id_required: { status: 400, message: 'Не вказано акаунт сервісу, з якого треба взяти замовлення для фактури.' },
  invoice_source_contract_invalid: { status: 409, message: ({ blockers = [] } = {}) => `Дані замовлення з сервісу не проходять контракт для фактури${Array.isArray(blockers) && blockers.length ? `: ${blockers.join(', ')}` : '.'}` },
  invoice_source_stale: { status: 409, message: 'Замовлення у вихідному сервісі змінилося після створення чернетки фактури. Оновіть чернетку з джерела перед фіналізацією.' },
  invoice_source_refresh_not_supported: { status: 409, message: 'Ця фактура не створена з provider-authoritative замовлення і не може оновлюватися з upstream.' },
  invoice_fiscal_provider_not_supported: { status: 400, message: 'Fiscal Provider не зареєстрований.' },
  invoice_fiscal_provider_not_live: { status: 409, message: 'Цей Fiscal Provider ще не має live-реалізації.' },
  ksef_environment_invalid: { status: 400, message: 'Некоректне середовище KSeF. Доступні test, demo або prod.' },
  ksef_ops_id_invalid: { status: 400, message: 'Некоректний ідентифікатор KSeF operational issue.' },
  ksef_ops_issue_kind_invalid: { status: 400, message: 'Некоректний тип KSeF operational issue.' },
  ksef_ops_retry_not_safe: { status: 409, message: 'Цю KSeF операцію не можна безпечно повторити автоматично. Потрібна ручна перевірка; blind replay POST заблоковано.' },
  ksef_ops_severity_invalid: { status: 400, message: 'Некоректний рівень KSeF operational event.' },
  ksef_connection_id_required: { status: 400, message: 'Не вказано KSeF connection.' },
  ksef_connection_not_found: { status: 404, message: 'KSeF connection не знайдено.' },
  ksef_connection_disabled: { status: 409, message: 'Цей KSeF connection вимкнений.' },
  ksef_connection_already_exists: { status: 409, message: 'Для цієї юридичної особи вже існує KSeF connection у вибраному середовищі.' },
  ksef_legal_entity_nip_required: { status: 409, message: 'Для KSeF потрібна активна польська юридична особа з коректним NIP.' },
  ksef_stage3_buyer_nip_invalid: { status: 409, message: 'Для польського покупця з NIP потрібен коректний польський NIP.' },
  ksef_token_required: { status: 400, message: 'Вкажіть token KSeF.' },
  ksef_secret_required: { status: 400, message: 'KSeF secret не може бути порожнім.' },
  ksef_credential_encryption_not_configured: { status: 503, message: 'На backend не налаштовано KSEF_CREDENTIAL_ENCRYPTION_KEY довжиною щонайменше 32 байти.' },
  ksef_secret_decrypt_failed: { status: 503, message: 'Не вдалося розшифрувати KSeF credentials. Перевірте KSEF_CREDENTIAL_ENCRYPTION_KEY.' },
  ksef_public_keys_unavailable: { status: 503, message: 'KSeF не повернув актуальні публічні ключі.' },
  ksef_public_key_not_found: { status: 503, message: ({ usage = '' } = {}) => `Не знайдено чинний публічний ключ KSeF${usage ? ` для ${usage}` : ''}.` },
  ksef_api_timeout: { status: 504, message: 'KSeF не відповів вчасно.' },
  ksef_api_unavailable: { status: 503, message: 'Зараз немає стабільного зʼєднання з KSeF API.' },
  ksef_rate_limited: { status: 503, message: 'KSeF тимчасово обмежив частоту API-запитів.' },
  ksef_api_error: { status: 502, message: ({ providerMessage = '' } = {}) => providerMessage ? `KSeF відхилив API-запит: ${providerMessage}` : 'KSeF відхилив API-запит.' },
  ksef_auth_failed: { status: 409, message: 'KSeF відхилив авторизацію. Перевірте credential/token, сертифікат, NIP-контекст і права.' },
  ksef_auth_rejected: { status: 409, message: 'Процес авторизації KSeF завершився помилкою.' },
  ksef_auth_timeout: { status: 504, message: 'KSeF не завершив авторизацію у відведений час.' },
  ksef_auth_response_invalid: { status: 502, message: 'KSeF повернув некоректну відповідь авторизації.' },
  ksef_session_response_invalid: { status: 502, message: 'KSeF не повернув номер online session.' },
  ksef_send_response_invalid: { status: 502, message: 'KSeF прийняв запит відправки, але не повернув reference number фактури.' },
  ksef_xsd_validator_unavailable: { status: 503, message: 'FA(3) XSD validator недоступний. Відправлення заблоковано fail-closed.' },
  ksef_xsd_validation_failed: { status: 409, message: 'FA(3) XML не пройшов XSD validation. Відправлення в KSeF заблоковано.' },
  ksef_invoice_not_supported: { status: 409, message: ({ blockers = [] } = {}) => `Ця фактура ще не підтримується KSeF Online Stage 3${Array.isArray(blockers) && blockers.length ? `: ${blockers.join(', ')}` : '.'}` },
  ksef_invoice_xml_invalid: { status: 409, message: 'Не вдалося безпечно побудувати FA(3) XML із finalized snapshot.' },
  ksef_invoice_must_be_finalized: { status: 409, message: 'Перед KSeF фактуру треба фіналізувати в immutable InvoiceSnapshot.' },
  ksef_invoice_snapshot_missing: { status: 409, message: 'Для фіналізованої фактури не знайдено InvoiceSnapshot.' },
  ksef_submission_not_found: { status: 404, message: 'KSeF submission для цієї фактури не знайдено.' },
  ksef_submission_not_sent: { status: 409, message: 'KSeF submission ще не має reference number відправленої фактури.' },
  ksef_submission_ambiguous: { status: 409, message: 'Результат відправки в KSeF неоднозначний після мережевої помилки. Автоматичний повтор заблоковано, щоб не створити дубль; потрібна reconciliation.' },
  ksef_session_invoice_list_truncated: { status: 502, message: 'Список фактур KSeF у сесії перевищив безпечний ліміт reconciliation. Автоматичне відновлення зупинено.' },
  ksef_submission_ambiguous_matches: { status: 409, message: ({ count = 0 } = {}) => `У KSeF-сесії знайдено ${count || 'кілька'} фактур з тим самим hash. Автоматична reconciliation зупинена, потрібна ручна перевірка.` },
  ksef_submission_not_found_in_session: { status: 409, message: 'KSeF-сесія вже завершена, але фактуру з нашим hash у ній не знайдено. Автоматичний повтор відправки заблоковано; потрібна ручна перевірка.' },
  ksef_upo_not_available: { status: 409, message: 'UPO ще не доступне для цієї фактури KSeF.' },
  ksef_upo_response_invalid: { status: 502, message: 'KSeF повернув порожнє або некоректне UPO.' },
  ksef_upo_hash_missing: { status: 502, message: 'KSeF не повернув контрольний SHA-256 для UPO. Збереження UPO заблоковано fail-closed.' },
  ksef_upo_hash_mismatch: { status: 502, message: 'SHA-256 отриманого UPO не збігається з hash, який повернув KSeF. Збереження UPO заблоковано.' },
  ksef_http_body_conflict: { status: 500, message: 'Внутрішня помилка KSeF transport: одночасно задано JSON і raw body.' },
  ksef_xades_credential_id_required: { status: 400, message: 'Не вказано XAdES credential.' },
  ksef_xades_credential_not_found: { status: 404, message: 'XAdES credential не знайдено.' },
  ksef_xades_credential_disabled: { status: 409, message: 'XAdES credential вимкнений.' },
  ksef_xades_credential_revoked: { status: 409, message: 'XAdES credential локально позначений як відкликаний.' },
  ksef_xades_credential_conflict: { status: 409, message: 'Цей XAdES certificate вже збережений з іншим private key material або metadata.' },
  ksef_xades_certificate_type_invalid: { status: 400, message: 'Некоректний тип XAdES credential certificate.' },
  ksef_xades_certificate_invalid: { status: 400, message: 'XAdES certificate має некоректний PEM/DER/Base64 формат.' },
  ksef_xades_certificate_key_mismatch: { status: 409, message: 'XAdES private key не відповідає публічному ключу сертифіката.' },
  ksef_xades_certificate_not_valid_now: { status: 409, message: 'XAdES certificate зараз поза строком дії.' },
  ksef_xades_authentication_certificate_usage_invalid: { status: 409, message: 'Сертифікат KSeF Authentication не має очікуваного Key Usage Digital Signature.' },
  ksef_xades_private_key_required: { status: 400, message: 'Для XAdES credential потрібен приватний ключ.' },
  ksef_xades_private_key_invalid: { status: 400, message: 'XAdES private key має некоректний PEM/Base64 DER формат.' },
  ksef_xades_private_key_algorithm_invalid: { status: 409, message: 'XAdES signer потребує RSA >= 2048 bit або EC curve >= 256 bit із підтриманого набору.' },
  ksef_xades_subject_identifier_type_invalid: { status: 400, message: 'SubjectIdentifierType має бути certificateSubject або certificateFingerprint.' },
  ksef_xades_auth_request_invalid: { status: 409, message: 'Не вдалося побудувати AuthTokenRequest 2.1 для XAdES.' },
  ksef_xades_signing_time_invalid: { status: 500, message: 'Некоректний SigningTime XAdES.' },
  ksef_xades_self_verification_failed: { status: 500, message: 'Згенерований XAdES не пройшов локальну cryptographic self-verification; запит у KSeF заблоковано.' },
  ksef_certificate_enrollment_data_invalid: { status: 502, message: 'KSeF повернув неповні або некоректні DN-дані для CSR.' },
  ksef_certificate_name_invalid: { status: 400, message: 'Назва KSeF certificate має містити 5–100 дозволених символів.' },
  ksef_certificate_type_invalid: { status: 400, message: 'Тип KSeF certificate має бути Authentication або Offline.' },
  ksef_certificate_csr_key_algorithm_invalid: { status: 400, message: 'CSR підтримує EC P-256 або RSA 2048.' },
  ksef_certificate_csr_self_verification_failed: { status: 500, message: 'Згенерований PKCS#10 CSR не пройшов локальну перевірку підпису.' },
  ksef_certificate_valid_from_invalid: { status: 400, message: 'Некоректний validFrom для KSeF certificate.' },
  ksef_certificate_limit_reached: { status: 409, message: 'KSeF не дозволяє подати новий certificate enrollment через поточні ліміти.' },
  ksef_certificate_enrollment_id_required: { status: 400, message: 'Не вказано certificate enrollment id.' },
  ksef_certificate_enrollment_not_found: { status: 404, message: 'Certificate enrollment не знайдено.' },
  ksef_certificate_enrollment_response_invalid: { status: 502, message: 'KSeF прийняв enrollment request, але не повернув referenceNumber.' },
  ksef_certificate_enrollment_ambiguous: { status: 409, message: 'Результат POST certificate enrollment неоднозначний після мережевої помилки. Автоматичний повтор заблоковано, щоб не створити дубль.' },
  ksef_certificate_enrollment_status_expired: { status: 409, message: 'KSeF більше не зберігає технічний status цього certificate enrollment. Автоматичне відновлення зупинено; потрібна ручна звірка виданих сертифікатів.' },
  ksef_certificate_private_key_missing: { status: 409, message: 'Приватний ключ certificate enrollment недоступний; автоматичне materialize заблоковано.' },
  ksef_certificate_serial_invalid: { status: 502, message: 'KSeF повернув некоректний certificate serial number.' },
  ksef_certificate_retrieve_response_invalid: { status: 502, message: 'KSeF не повернув рівно один очікуваний certificate DER/type для issued enrollment.' },
  ksef_certificate_revocation_reason_invalid: { status: 400, message: 'revocationReason має бути Unspecified, Superseded або KeyCompromise.' },
  ksef_offline_certificate_id_required: { status: 400, message: 'Не вказано ідентифікатор Offline certificate KSeF.' },
  ksef_offline_certificate_not_found: { status: 404, message: 'Активний Offline certificate KSeF для цієї юридичної особи та середовища не знайдено.' },
  ksef_offline_certificate_disabled: { status: 409, message: 'Offline certificate KSeF вимкнений.' },
  ksef_offline_certificate_type_required: { status: 400, message: 'Для offline24 потрібен сертифікат KSeF типу Offline.' },
  ksef_offline_certificate_invalid: { status: 400, message: 'Сертифікат KSeF має некоректний DER/Base64 формат або серійний номер.' },
  ksef_offline_certificate_usage_invalid: { status: 400, message: 'Сертифікат не має Key Usage для KSeF Offline (Content Commitment / Non-Repudiation) або є сертифікатом Authentication.' },
  ksef_offline_certificate_conflict: { status: 409, message: 'Сертифікат KSeF з таким серійним номером уже існує з іншим certificate/private key material.' },
  ksef_offline_certificate_key_mismatch: { status: 409, message: 'Приватний ключ не відповідає публічному ключу імпортованого сертифіката KSeF.' },
  ksef_offline_certificate_not_valid_now: { status: 409, message: 'Offline certificate KSeF зараз поза строком дії. Підготовку offline24 заблоковано.' },
  ksef_offline_private_key_required: { status: 400, message: 'Для Offline certificate KSeF потрібен приватний ключ.' },
  ksef_offline_private_key_invalid: { status: 400, message: 'Приватний ключ Offline certificate має некоректний PEM/Base64 DER формат.' },
  ksef_offline_private_key_algorithm_invalid: { status: 409, message: 'Offline certificate потребує RSA щонайменше 2048 bit або EC P-256.' },
  ksef_offline_invoice_hash_invalid: { status: 409, message: 'Не вдалося побудувати QR KSeF: hash фактури не є SHA-256.' },
  ksef_offline_issue_date_invalid: { status: 409, message: 'Не вдалося побудувати QR KSeF: дата виставлення має формат YYYY-MM-DD.' },
  ksef_offline_context_identifier_invalid: { status: 409, message: 'Некоректний ContextIdentifier для QR II KSeF.' },
  ksef_submission_mode_invalid: { status: 409, message: 'KSeF submission має непідтримуваний режим відправлення.' },
  ksef_submission_mode_conflict: { status: 409, message: 'Для цього immutable snapshot уже зафіксовано інший режим KSeF submission; автоматична зміна режиму заблокована.' },
  invoice_correction_original_must_be_finalized: { status: 409, message: 'Корекцію можна створити лише для фіналізованої фактури.' },
  invoice_correction_original_snapshot_missing: { status: 409, message: 'Immutable snapshot оригінальної фактури недоступний.' },
  invoice_correction_original_ksef_required: { status: 409, message: 'Звичайна KSeF-корекція потребує прийнятої оригінальної фактури з номером KSeF.' },
  invoice_correction_chain_requires_explicit_flag: { status: 409, message: 'Корекція корекції потребує explicit allowCorrectionOfCorrection=true.' },
  invoice_correction_reason_required: { status: 400, message: 'Для faktura korygująca потрібно вказати причину корекції.' },
  invoice_correction_type_invalid: { status: 400, message: 'TypKorekty має бути 1, 2 або 3.' },
  invoice_correction_items_required: { status: 400, message: 'Для common KOR потрібні signed delta correction rows.' },
  invoice_correction_invalid: { status: 409, message: 'Correction draft не пройшов provider-neutral correction contract.' },
  ksef_technical_correction_id_invalid: { status: 400, message: 'Некоректний id технічної корекції KSeF.' },
  ksef_technical_correction_not_found: { status: 404, message: 'Технічну корекцію KSeF не знайдено.' },
  ksef_technical_correction_offline_only: { status: 409, message: 'Технічна корекція доступна лише для фактури, надісланої як offline.' },
  ksef_technical_correction_status_invalid: { status: 409, message: 'Поточний статус оригінальної offline-фактури не дозволяє технічну корекцію.' },
  ksef_technical_correction_original_hash_missing: { status: 409, message: 'Немає immutable SHA-256 первинної відхиленої offline-фактури.' },
  ksef_technical_correction_artifact_unchanged: { status: 409, message: 'Новий XML має той самий SHA-256, що й відхилена offline-фактура. Технічна корекція не створена.' },
  ksef_technical_correction_state_invalid: { status: 409, message: 'Технічна корекція не перебуває у стані, який дозволяє нову відправку.' },
  ksef_technical_correction_not_submitted: { status: 409, message: 'Технічна корекція ще не має KSeF session reference.' },
  ksef_technical_correction_ambiguous: { status: 409, message: 'Результат відправлення технічної корекції неоднозначний. Blind replay POST заблоковано; використайте reconcile.' },
  ksef_technical_correction_rejected: { status: 409, message: 'KSeF відхилив технічну корекцію.' },
  ksef_inbound_auth_method_invalid: { status: 400, message: 'Inbound KSeF підтримує token_connection або xades.' },
  ksef_inbound_auth_ref_required: { status: 400, message: 'Для inbound KSeF потрібно вказати authRefId.' },
  ksef_inbound_auth_scope_mismatch: { status: 409, message: 'Inbound KSeF auth credential не відповідає цій юридичній особі або середовищу.' },
  ksef_inbound_sync_exists: { status: 409, message: 'Для цієї юридичної особи та середовища вже існує inbound KSeF sync Subject2.' },
  ksef_inbound_sync_id_required: { status: 400, message: 'Не вказано inbound KSeF sync id.' },
  ksef_inbound_sync_not_found: { status: 404, message: 'Inbound KSeF sync не знайдено.' },
  ksef_inbound_sync_disabled: { status: 409, message: 'Inbound KSeF sync вимкнений або недоступний.' },
  ksef_inbound_sync_busy: { status: 409, message: 'Inbound KSeF sync уже виконується іншим worker.' },
  ksef_inbound_sync_not_due: { status: 409, message: 'Inbound KSeF sync ще не досяг дозволеного часу наступного запуску.' },
  ksef_inbound_cursor_invalid: { status: 400, message: 'Некоректний PermanentStorage cursor inbound KSeF.' },
  ksef_inbound_metadata_response_invalid: { status: 502, message: 'KSeF повернув некоректну відповідь metadata query.' },
  ksef_inbound_metadata_truncated: { status: 409, message: 'KSeF metadata query перевищив межу 10 000 документів. HWM cursor не пересунуто; потрібен Stage 6B export/high-volume flow або інша контрольована стратегія.' },
  ksef_inbound_hwm_missing: { status: 502, message: 'KSeF metadata response не містить PermanentStorageHwmDate. Cursor не змінено.' },
  ksef_inbound_hwm_invalid: { status: 502, message: 'KSeF повернув неконсистентний PermanentStorage HWM. Cursor не змінено.' },
  ksef_inbound_metadata_invalid: { status: 502, message: 'KSeF повернув metadata без коректного номера KSeF.' },
  ksef_inbound_metadata_hash_invalid: { status: 502, message: 'KSeF повернув metadata без коректного SHA-256 invoiceHash.' },
  ksef_inbound_metadata_hash_conflict: { status: 409, message: 'Для цього номера KSeF уже збережено інший invoiceHash. Автоматичне оновлення заблоковано.' },
  ksef_inbound_document_conflict: { status: 409, message: 'Локальний inbound KSeF document має конфлікт identity/artifact.' },
  ksef_inbound_document_id_invalid: { status: 400, message: 'Некоректний inbound KSeF document id.' },
  ksef_inbound_document_state_invalid: { status: 400, message: 'Некоректний стан вхідного документа KSeF.' },
  ksef_inbound_document_not_found: { status: 404, message: 'Inbound KSeF document не знайдено.' },
  business_counterparty_id_invalid: { status: 400, message: 'Некоректний business counterparty id.' },
  business_counterparty_not_found: { status: 404, message: 'Business counterparty не знайдено.' },
  business_counterparty_name_required: { status: 400, message: 'Вкажіть юридичну назву контрагента.' },
  business_counterparty_role_invalid: { status: 400, message: 'Некоректна роль business counterparty.' },
  business_counterparty_status_invalid: { status: 400, message: 'Некоректний статус business counterparty.' },
  business_counterparty_tax_id_exists: { status: 409, message: 'Контрагент з таким податковим ідентифікатором уже існує.' },
  inbound_business_link_id_invalid: { status: 400, message: 'Некоректний inbound business link id.' },
  inbound_business_link_not_found: { status: 404, message: 'Inbound business link не знайдено.' },
  inbound_business_link_target_id_invalid: { status: 400, message: 'Некоректний target id для inbound business link.' },
  inbound_business_link_target_type_invalid: { status: 400, message: 'Inbound business link підтримує лише business_counterparty або receipt.' },
  inbound_business_counterparty_already_confirmed: { status: 409, message: 'Для цієї вхідної фактури вже підтверджено іншого постачальника. Для заміни потрібен explicit replace.' },
  ksef_inbound_document_manual_review: { status: 409, message: 'Inbound KSeF document заблокований до ручної перевірки.' },
  ksef_inbound_document_busy: { status: 409, message: 'Inbound KSeF document уже завантажується іншим worker або ще не готовий до повтору.' },
  ksef_inbound_invoice_response_invalid: { status: 502, message: 'KSeF повернув порожню або некоректну XML-фактуру.' },
  ksef_inbound_hash_header_missing: { status: 502, message: 'KSeF не повернув x-ms-meta-hash для отриманої фактури. Збереження заблоковано fail-closed.' },
  ksef_inbound_artifact_hash_mismatch: { status: 409, message: 'SHA-256 XML не збігається одночасно з metadata invoiceHash і x-ms-meta-hash KSeF. Документ переведено в manual review.' },
  ksef_inbound_artifact_not_available: { status: 409, message: 'XML inbound KSeF ще не збережений локально.' },
  ksef_inbound_local_artifact_hash_mismatch: { status: 500, message: 'Локальний immutable XML inbound KSeF не пройшов повторну SHA-256 перевірку. Видачу заблоковано.' },
  ksef_inbound_export_active: { status: 409, message: 'Для цього inbound sync уже активний high-volume export. Cursor не можна змінювати до його завершення або ручного розбору.' },
  ksef_inbound_export_id_required: { status: 400, message: 'Не вказано inbound KSeF export id.' },
  ksef_inbound_export_not_found: { status: 404, message: 'Inbound KSeF export не знайдено.' },
  ksef_inbound_export_state_invalid: { status: 400, message: 'Некоректний стан inbound KSeF export.' },
  ksef_inbound_export_window_invalid: { status: 400, message: 'Некоректне PermanentStorage-вікно для inbound KSeF export.' },
  ksef_inbound_export_conflict: { status: 409, message: 'Не вдалося однозначно створити або відновити durable inbound KSeF export.' },
  ksef_inbound_export_secret_invalid: { status: 500, message: 'Зашифрований AES key/IV inbound KSeF export пошкоджений або має некоректну довжину.' },
  ksef_inbound_export_submit_response_invalid: { status: 502, message: 'KSeF не повернув коректний referenceNumber після запуску export.' },
  ksef_inbound_export_submit_failed: { status: 502, message: 'Не вдалося безпечно запустити inbound KSeF export.' },
  ksef_inbound_export_status_invalid: { status: 502, message: 'KSeF повернув некоректний status payload inbound export.' },
  ksef_inbound_export_provider_failed: { status: 502, message: 'KSeF завершив inbound export з помилкою.' },
  ksef_inbound_export_package_invalid: { status: 502, message: 'KSeF повернув некоректний опис export package.' },
  ksef_inbound_export_package_expired: { status: 409, message: 'Підготовлений KSeF export package уже недоступний за строком дії.' },
  ksef_inbound_export_package_size_mismatch: { status: 409, message: 'Розмір розшифрованого KSeF export package не збігається з provider metadata.' },
  ksef_inbound_export_url_invalid: { status: 502, message: 'KSeF повернув небезпечний або некоректний signed URL export part.' },
  ksef_inbound_export_part_download_failed: { status: 502, message: 'Не вдалося завантажити signed export part KSeF.' },
  ksef_inbound_export_part_timeout: { status: 504, message: 'Перевищено час завантаження export part KSeF.' },
  ksef_inbound_export_part_too_large: { status: 502, message: 'Export part KSeF перевищує дозволений локальний safety limit.' },
  ksef_inbound_export_part_link_expired: { status: 409, message: 'Signed URL export part KSeF прострочений; status потрібно запросити повторно для нового URL.' },
  ksef_inbound_export_encrypted_part_mismatch: { status: 409, message: 'Encrypted size/SHA-256 export part не збігається з KSeF metadata.' },
  ksef_inbound_export_decrypt_failed: { status: 409, message: 'Не вдалося AES-256-CBC розшифрувати export part KSeF.' },
  ksef_inbound_export_plain_part_mismatch: { status: 409, message: 'Decrypted size/SHA-256 export part не збігається з KSeF metadata.' },
  ksef_inbound_export_archive_invalid: { status: 409, message: 'Розшифрований TarGz export package пошкоджений або невалідний.' },
  ksef_inbound_export_archive_too_large: { status: 409, message: 'Розпакований KSeF export перевищує локальний safety limit.' },
  ksef_inbound_export_entry_too_large: { status: 409, message: 'Окремий файл у KSeF export перевищує локальний safety limit.' },
  ksef_inbound_export_tar_invalid: { status: 409, message: 'Некоректна TAR структура KSeF export.' },
  ksef_inbound_export_tar_checksum_invalid: { status: 409, message: 'TAR header checksum KSeF export не збігається.' },
  ksef_inbound_export_tar_path_invalid: { status: 409, message: 'KSeF export містить небезпечний TAR path.' },
  ksef_inbound_export_metadata_invalid: { status: 409, message: 'Файл _metadata.json у KSeF export некоректний.' },
  ksef_inbound_export_metadata_duplicate: { status: 409, message: 'KSeF export містить більше одного _metadata.json.' },
  ksef_inbound_export_metadata_conflict: { status: 409, message: 'Metadata KSeF export конфліктує з уже збереженою identity/hash фактури.' },
  ksef_inbound_export_invoice_count_mismatch: { status: 409, message: 'Кількість metadata entries не збігається з invoiceCount KSeF export package.' },
  ksef_inbound_export_xml_unmatched: { status: 409, message: 'XML з KSeF export не має відповідного invoiceHash у _metadata.json.' },
  ksef_inbound_export_xml_ambiguous: { status: 409, message: 'XML з KSeF export неоднозначно відповідає кільком metadata documents.' },
  ksef_inbound_export_xml_duplicate: { status: 409, message: 'KSeF export містить дубль XML для одного inbound document.' },
  ksef_inbound_export_xml_count_mismatch: { status: 409, message: 'Кількість XML у KSeF export не збігається з _metadata.json.' },
  ksef_inbound_export_document_busy: { status: 409, message: 'Один з inbound documents паралельно обробляється іншим worker; export cursor не пересунуто.' },
  ksef_inbound_export_hwm_invalid: { status: 502, message: 'KSeF export не повернув безпечний HWM continuation point.' },
  invoice_id_invalid: { status: 400, message: 'Некоректний ідентифікатор фактури.' },
  invoice_numbering_failed: { status: 500, message: 'Не вдалося безпечно сформувати номер фактури.' },
  invoice_issue_date_required_for_numbering: { status: 409, message: 'Для автоматичної нумерації спочатку вкажіть дату виставлення фактури.' },
  legal_entity_required: { status: 409, message: 'Не налаштовано юридичну особу продавця для фактур.' },
  legal_entity_not_found: { status: 404, message: 'Юридичну особу не знайдено.' },
  legal_entity_inactive: { status: 409, message: 'Ця юридична особа вимкнена і не може виставляти нові фактури.' },
  legal_entity_id_invalid: { status: 400, message: 'Некоректний ідентифікатор юридичної особи.' },
  legal_entity_name_required: { status: 400, message: 'Вкажіть повну назву юридичної особи.' },
  legal_entity_country_invalid: { status: 400, message: 'Некоректний код країни юридичної особи.' },
  legal_entity_tax_id_required: { status: 400, message: 'Вкажіть податковий номер юридичної особи.' },
  legal_entity_tax_id_invalid: { status: 400, message: 'Податковий номер юридичної особи некоректний.' },
  legal_entity_currency_invalid: { status: 400, message: 'Валюта за замовчуванням має бути трилітерним ISO-кодом.' },
  legal_entity_numbering_invalid: { status: 400, message: 'Налаштування серії нумерації фактур некоректні.' },
  legal_entity_bank_account_default_conflict: { status: 400, message: 'У юридичної особи може бути лише один основний банківський рахунок.' },
  commerce_product_name_required: { status: 400, message: 'Вкажіть назву товару Commerce Catalog.' },
  commerce_product_not_found: { status: 404, message: 'Товар Commerce Catalog не знайдено.' },
  commerce_product_sku_duplicate: { status: 409, message: 'Товар з таким SKU вже існує в Commerce Catalog.' },
  commerce_category_name_required: { status: 400, message: 'Вкажіть назву категорії Commerce Product Master.' },
  commerce_category_not_found: { status: 404, message: 'Категорію Commerce Product Master не знайдено.' },
  commerce_category_slug_duplicate: { status: 409, message: 'Категорія з таким slug уже існує.' },
  commerce_category_parent_invalid: { status: 409, message: 'Батьківська категорія недоступна або створює цикл.' },
  commerce_warehouse_products_required: { status: 400, message: 'Оберіть хоча б один складський товар для додавання в Commerce Catalog.' },
  commerce_warehouse_product_not_found: { status: 400, message: 'Одна з прив’язок Commerce Catalog вказує на складський товар, якого не існує.' },
  commerce_publication_products_required: { status: 400, message: 'Оберіть хоча б один товар для перевірки публікації.' },
  commerce_publication_targets_required: { status: 400, message: 'Оберіть хоча б один marketplace-акаунт для публікації.' },
  commerce_publication_provider_unsupported: { status: 400, message: 'Цей marketplace adapter ще не підтримує підготовку публікації.' },
  commerce_provider_not_supported: { status: 400, message: 'Commerce Provider не зареєстрований у Provider Core.' },
  commerce_provider_not_live: { status: 409, message: 'Цей Commerce Provider ще не має live adapter.' },
  commerce_provider_operation_not_supported: { status: 400, message: 'Ця операція не підтримується вибраним Commerce Provider adapter.' },
  commerce_provider_capability_not_supported: { status: 409, message: 'Вибраний Commerce Provider не підтримує потрібну capability.' },
  commerce_allegro_mapping_scope_required: { status: 409, message: 'Для Allegro mapping потрібен scope allegro:api:sale:offers:read. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_category_required: { status: 400, message: 'Оберіть категорію Allegro перед збереженням mapping.' },
  commerce_allegro_mapping_not_ready: { status: 409, message: ({ missing = [] } = {}) => `Allegro mapping ще не готовий${Array.isArray(missing) && missing.length ? `: ${missing.join(', ')}` : '.'}` },
  commerce_allegro_draft_scope_required: { status: 409, message: 'Для створення draft потрібен scope allegro:api:sale:offers:write. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_draft_preflight_failed: { status: 409, message: ({ issues = [] } = {}) => `Товар ще не готовий до створення Allegro draft${Array.isArray(issues) && issues.length ? `: ${issues.join(' · ')}` : '.'}` },
  commerce_allegro_draft_images_required: { status: 409, message: 'Для нового продукту Allegro потрібне хоча б одне публічно доступне HTTP(S)-зображення.' },
  commerce_allegro_draft_response_invalid: { status: 502, message: 'Allegro прийняв створення draft, але не повернув ідентифікатор offer.' },
  commerce_allegro_draft_recovery_ambiguous: { status: 409, message: 'У Allegro знайдено більше одного offer з нашим external.id. Автоматичний recovery зупинено, щоб не прив’язати неправильний offer.' },
  commerce_allegro_draft_not_bound: { status: 409, message: 'Для цього ChannelListing ще немає прив’язаного Allegro offer. Спочатку створіть або відновіть draft.' },
  commerce_allegro_reconcile_scope_required: { status: 409, message: 'Для звірки draft потрібен scope allegro:api:sale:offers:read. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_reconcile_response_invalid: { status: 502, message: 'Allegro не повернув коректні дані offer для звірки.' },
  commerce_allegro_sales_settings_scope_required: { status: 409, message: 'Для Sales Settings потрібен scope allegro:api:sale:settings:read. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_sales_settings_reconciliation_required: { status: 409, message: 'Спочатку звірте INACTIVE draft з Allegro без розбіжностей (Stage 3D.1).' },
  commerce_allegro_sales_settings_invalid: { status: 400, message: ({ missing = [] } = {}) => `Не всі Sales Settings готові${Array.isArray(missing) && missing.length ? `: ${missing.join(', ')}` : '.'}` },
  commerce_allegro_sales_settings_apply_scope_required: { status: 409, message: 'Для застосування Sales Settings потрібні scopes allegro:api:sale:offers:read і allegro:api:sale:offers:write. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_sales_settings_apply_not_ready: { status: 409, message: 'Sales Settings ще не готові до застосування. Спочатку збережіть повний mapping Stage 3D.2.' },
  commerce_allegro_sales_settings_apply_hash_mismatch: { status: 409, message: 'Sales Settings змінилися після збереження. Відкрийте Stage 3D.2 і збережіть mapping повторно перед apply.' },
  commerce_allegro_sales_settings_offer_not_inactive: { status: 409, message: ({ publicationStatus = '' } = {}) => `Sales Settings apply дозволений тільки для INACTIVE draft. Поточний статус Allegro: ${publicationStatus || 'невідомий'}.` },
  commerce_allegro_sales_settings_apply_response_invalid: { status: 502, message: 'Allegro не повернув коректний offer під час перевірки застосованих Sales Settings.' },
  commerce_allegro_sales_settings_apply_mismatch: { status: 409, message: 'Allegro завершив операцію, але фактичні Sales Settings не збігаються з нашим mapping.' },
  commerce_allegro_activation_scope_required: { status: 409, message: 'Для активації offer потрібні scopes allegro:api:sale:offers:read і allegro:api:sale:offers:write. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_activation_preflight_failed: { status: 409, message: ({ issues = [] } = {}) => `Offer ще не готовий до активації${Array.isArray(issues) && issues.length ? `: ${issues.join(' · ')}` : '.'}` },
  commerce_allegro_activation_reconciliation_required: { status: 409, message: 'Перед активацією INACTIVE draft має пройти актуальну Stage 3D.1 звірку без drift.' },
  commerce_allegro_activation_sales_settings_required: { status: 409, message: 'Перед активацією Sales Settings мають бути застосовані та підтверджені read-back з Allegro.' },
  commerce_allegro_activation_sales_settings_drift: { status: 409, message: ({ issues = [] } = {}) => `Sales Settings в Allegro змінилися після apply${Array.isArray(issues) && issues.length ? `: ${issues.join(' · ')}` : '.'}` },
  commerce_allegro_activation_offer_not_inactive: { status: 409, message: ({ publicationStatus = '' } = {}) => `Активацію можна запускати тільки для INACTIVE offer. Поточний статус Allegro: ${publicationStatus || 'невідомий'}.` },
  commerce_allegro_activation_response_invalid: { status: 502, message: 'Allegro не повернув коректний offer під час перевірки активації.' },
  commerce_allegro_update_preview_scope_required: { status: 409, message: 'Для preview змін ACTIVE offer потрібен scope allegro:api:sale:offers:read. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_update_preview_response_invalid: { status: 502, message: 'Allegro не повернув коректний ACTIVE offer для preview змін.' },
  commerce_allegro_content_update_scope_required: { status: 409, message: 'Для оновлення контенту потрібні scopes allegro:api:sale:offers:read і allegro:api:sale:offers:write. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_content_update_mapping_review_required: { status: 409, message: 'Category/product mapping змінився. Автоматичний content PATCH зупинено — спочатку перегляньте mapping.' },
  commerce_allegro_content_update_offer_not_active: { status: 409, message: 'Content Update дозволений тільки для ACTIVE offer.' },
  commerce_allegro_content_update_job_invalid: { status: 409, message: 'Не вдалося відновити durable Content Update job. Виконайте fresh preview і повторіть дію.' },
  commerce_allegro_content_update_response_invalid: { status: 502, message: 'Allegro не повернув коректний offer під час перевірки Content Update.' },
  commerce_allegro_price_sync_items_required: { status: 400, message: 'Оберіть хоча б один Allegro offer для синхронізації ціни.' },
  commerce_allegro_price_sync_automation_confirmation_required: { status: 409, message: ({ count = 0 } = {}) => `Для ${count || 'вибраних'} offer активна price automation. Власна FIXED price вимкне цю rule — потрібне явне підтвердження.` },
  commerce_allegro_stock_sync_items_required: { status: 400, message: 'Оберіть хоча б один Allegro offer для перевірки або синхронізації залишку.' },
  commerce_allegro_stock_preview_scope_required: { status: 409, message: 'Для Stock Preview потрібен scope allegro:api:sale:offers:read. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_stock_sync_scope_required: { status: 409, message: 'Для Stock Sync потрібні scopes allegro:api:sale:offers:read і allegro:api:sale:offers:write. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_stock_sync_reservation_mapping_incomplete: { status: 409, message: 'Stock Sync заблоковано: є online-order позиції, які не вдалося однозначно зіставити з Commerce Product.' },
  commerce_allegro_stock_sync_inventory_movements_blocked: { status: 409, message: 'Stock Sync заблоковано: не всі consumed/shipped reservations безпечно проведені через Commerce Inventory movements.' },
  commerce_allegro_stock_sync_end_confirmation_required: { status: 409, message: ({ count = 0 } = {}) => `Для ${count || 'вибраних'} ACTIVE offer desired stock дорівнює 0. Allegro завершить ці offer — потрібне явне підтвердження.` },
  commerce_allegro_lifecycle_scope_required: { status: 409, message: 'Для lifecycle END/REOPEN потрібні scopes allegro:api:sale:offers:read і allegro:api:sale:offers:write. Перепідключіть цей магазин через OAuth.' },
  commerce_allegro_health_items_required: { status: 400, message: 'Потрібно вибрати товари для Allegro health scan.' },
  commerce_allegro_lifecycle_action_required: { status: 400, message: 'Lifecycle action має бути end або reopen.' },
  commerce_allegro_lifecycle_response_invalid: { status: 502, message: 'Allegro не повернув коректний offer під час lifecycle перевірки.' },
  commerce_allegro_lifecycle_offer_missing: { status: 409, message: 'Offer більше недоступний через product-offers (можливо, заархівований або видалений). Автоматичний reopen зупинено.' },
  commerce_allegro_lifecycle_transition_invalid: { status: 409, message: ({ action = '', publicationStatus = '' } = {}) => `Lifecycle ${action || 'action'} не дозволений для статусу ${publicationStatus || 'UNKNOWN'}.` },
  commerce_allegro_lifecycle_reopen_not_ready: { status: 409, message: ({ blockers = [] } = {}) => `ENDED offer ще не готовий до reopen${Array.isArray(blockers) && blockers.length ? `: ${blockers.join(' · ')}` : '.'}` },
  commerce_allegro_lifecycle_command_failed: { status: 409, message: 'Allegro lifecycle command завершився помилкою. Перевірте task details і виконайте явний retry після виправлення причини.' },
  commerce_allegro_lifecycle_reopen_stale_stock: { status: 409, message: 'Commerce desired stock змінився під час reopen. ACTIVATE зупинено; виконайте fresh lifecycle preview і повторіть reopen з актуальним stock.' },
  not_found:                { status: 404, message: 'Не знайдено' },
  forbidden:                { status: 403, message: 'Недостатньо прав для цієї дії' },
  unauthenticated:          { status: 401, message: 'Потрібна авторизація' },

  // ── Receipts ───────────────────────────────────────────────────────────────
  receipt_not_found:        { status: 404, message: 'Накладну не знайдено' },
  receipt_already_completed:{ status: 409, message: 'Накладну вже проведено' },
  receipt_no_items:         { status: 400, message: 'У накладній немає позицій' },
  receipt_items_incomplete: { status: 400, message: 'Не всі товари повністю описані' },
  // Проведену накладну редагувати МОЖНА (docs/receipt/readme.md §5). Відмова
  // приходить не від статусу накладної, а від того, що товар уже поїхав далі.
  receipt_item_in_use:      { status: 409, message: ({ reasons } = {}) =>
                                `Товар уже в робочому процесі: ${reasons || 'товар використовується'}. ` +
                                'Скасування, перепризначення та зміна ключових даних заблоковані.' },
  receipt_item_not_found:   { status: 404, message: 'Позицію не знайдено' },
  receipt_save_failed:      { status: 500, message: 'Не вдалося оновити позицію' },
  receipt_item_stale:       { status: 409, message: ({ currentRevision } = {}) =>
                                `Цей товар уже змінив інший працівник${currentRevision != null ? ` (актуальна версія: ${currentRevision})` : ''}. Ваші застарілі дані не були записані. Оновіть картку і повторіть.` },
  receipt_route_stale:      { status: 409, message: ({ currentRevision } = {}) =>
                                `Маршрут цього товару вже змінив інший працівник${currentRevision != null ? ` (актуальна версія: ${currentRevision})` : ''}. Ваш маршрут не був записаний. Оновіть картку і повторіть.` },
  receipt_commit_failed:    { status: 500, message: 'Не вдалося провести накладну' },
  receipt_delete_item_failed:{ status: 500, message: 'Не вдалося видалити позицію' },

  // ── Users ──────────────────────────────────────────────────────────────────
  user_activity_filter_retired: { status: 400, message: 'Цей фільтр активності застарів. Стан замовлень доступний у межах конкретної сесії.' },
  cleared_cart_legacy_unrestorable: { status: 409, message: 'Знімок старого кошика не містить сесії замовлення. Автоматичне відновлення недоступне; перегляньте історію замовлень.' },
  user_not_found:           { status: 404, message: 'Користувача не знайдено' },
  user_telegram_id_taken:   { status: 409, message: ({ telegramId } = {}) =>
                                `Користувач з Telegram ID ${telegramId || ''} вже існує. Оновіть сторінку і повторіть.` },
  user_create_failed:       { status: 500, message: 'Не вдалося створити користувача' },
  user_has_active_work:     { status: 409, message: ({ activeOrders = 0, activePickingTasks = 0 } = {}) =>
                                `Не можна видалити користувача: ${activeOrders} активне замовлення, ${activePickingTasks} активний пакувальний таск. Спочатку завершіть або скасуйте їх.` },

  // ── Shops ──────────────────────────────────────────────────────────────────
  shop_not_found:           { status: 404, message: 'Магазин не знайдено' },
  shop_inactive:            { status: 409, message: 'Магазин неактивний. Активуйте магазин або призначте користувача до іншого магазину.' },
  shop_no_delivery_group:   { status: 409, message: 'Магазин не прив’язано до групи доставки.' },
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
  group_has_history:        { status: 409, message: ({ sessions = 0 } = {}) =>
                                `Не можна видалити групу: ${sessions} сесія(й) уже містять історію замовлень/збирання. Історичні дані не видаляються каскадно.` },

  ordering_session_not_found:{ status: 404, message: 'Сесію замовлень не знайдено' },
  ordering_session_changed:  { status: 409, message: 'Сесія замовлень змінилася. Оновіть екран і повторіть дію.' },
  seller_assignment_changed: { status: 409, message: 'Ваше призначення до магазину змінилося. Оновіть дані та повторіть дію.' },
  shop_switch_order_conflict: { status: 409, message: 'Не вдалося змінити магазин: для цього продавця вже існує активне замовлення в цільовій сесії. Дані не змінено.' },
  shop_switch_conflict: { status: 409, message: 'Не вдалося змінити магазин через одночасну зміну даних. Актуальний стан відновлено — повторіть дію.' },
  seller_order_assignment_invariant: { status: 409, message: ({ kind } = {}) =>
                                `Стан продавця та його активного замовлення суперечливий${kind ? ` (${kind})` : ''}. Дані не змінено — потрібна перевірка або явне виправлення замовлення.` },

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
  product_archived_cannot_shelve: { status: 409, message: 'Архівований товар не можна розмістити в блоці — спершу відновіть його з архіву' },
  product_not_in_source_block:{ status: 400, message: 'Товар не у вихідному блоці' },
  block_move_invalid_fields:{ status: 400, message: 'Невалідні параметри переносу: productId, fromBlock, toBlock, toIndex' },
  block_concurrent_modification: { status: 409, message: 'Блок змінюється кількома користувачами одночасно. Спробуйте ще раз.' },

  // ── BaseLinker ──────────────────────────────────────────────────────────────
  baselinker_not_configured: { status: 503, message: 'BaseLinker не налаштовано. Додайте хоча б один BaseLinker-акаунт у Settings.' },
  baselinker_account_id_required: { status: 400, message: 'Не вказано BaseLinker accountId. Для мультиакаунтної системи order_id без accountId неоднозначний.' },
  baselinker_account_not_found: { status: 404, message: 'BaseLinker-акаунт не знайдено.' },
  baselinker_account_disabled: { status: 409, message: 'Цей BaseLinker-акаунт вимкнений. Нові API-операції для нього заблоковані.' },
  baselinker_account_name_required: { status: 400, message: 'Вкажіть назву BaseLinker-акаунта.' },
  baselinker_token_required: { status: 400, message: 'Вкажіть API-токен BaseLinker.' },
  baselinker_token_encryption_not_configured: { status: 503, message: 'Для збереження BaseLinker-токенів на сервері потрібно налаштувати BASELINKER_TOKEN_ENCRYPTION_KEY.' },
  baselinker_token_decrypt_failed: { status: 503, message: 'Не вдалося розшифрувати BaseLinker-токен. Перевірте BASELINKER_TOKEN_ENCRYPTION_KEY.' },
  baselinker_token_already_connected: { status: 409, message: 'Цей самий API-токен уже підключений до іншого BaseLinker-акаунта.' },
  baselinker_token_rotation_confirmation_required: { status: 409, message: 'Заміна токена зберігає поточний accountId. Потрібно явно підтвердити, що новий токен належить цьому самому BaseLinker-акаунту.' },
  baselinker_source_filter_invalid: { status: 400, message: 'Некоректний фільтр джерела BaseLinker. Конкретне джерело завжди задається разом з accountId, sourceType і sourceId.' },
  baselinker_rate_budget_exhausted: { status: 429, message: ({ retryAfterMs } = {}) => `Наш безпечний бюджет BaseLinker API для цього акаунта вичерпано.${retryAfterMs ? ` Повторіть приблизно через ${Math.ceil(Number(retryAfterMs) / 1000)} с.` : ''}` },
  baselinker_timeout:        { status: 504, message: ({ upstreamMethod } = {}) =>
                                `BaseLinker не відповів вчасно${upstreamMethod ? ` на ${upstreamMethod}` : ''}. Повторіть запит.` },
  baselinker_network_error:  { status: 502, message: ({ upstreamMethod, upstreamMessage } = {}) =>
                                `Не вдалося з’єднатися з BaseLinker${upstreamMethod ? ` під час ${upstreamMethod}` : ''}${upstreamMessage ? `: ${upstreamMessage}` : '.'}` },
  baselinker_unavailable:    { status: 502, message: 'BaseLinker API зараз недоступний.' },
  baselinker_http_error:     { status: 502, message: ({ upstreamMethod, upstreamStatus, upstreamCode, upstreamMessage } = {}) => {
                                const where = upstreamMethod ? ` під час ${upstreamMethod}` : '';
                                const details = `${upstreamCode ? ` (${upstreamCode})` : ''}${upstreamMessage ? `: ${upstreamMessage}` : ''}`;
                                if (Number(upstreamStatus) === 401) return `BaseLinker відхилив API-токен${where} (HTTP 401). Перевірте API-токен цього BaseLinker-акаунта в Налаштуваннях.${details}`;
                                if (Number(upstreamStatus) === 403) return `BaseLinker заборонив цю API-операцію${where} (HTTP 403). Перевірте права API-токена.${details}`;
                                if (Number(upstreamStatus) === 429) return `BaseLinker тимчасово відхилив запит через ліміт API${where} (HTTP 429). Зачекайте трохи й повторіть.${details}`;
                                return `BaseLinker повернув HTTP ${upstreamStatus || 'помилку'}${where}${details}.`;
                              } },
  baselinker_invalid_response: { status: 502, message: ({ upstreamMethod } = {}) =>
                                `BaseLinker повернув некоректну відповідь${upstreamMethod ? ` на ${upstreamMethod}` : ''}. Дані не змінено; повторіть запит.` },
  baselinker_api_error:      { status: 502, message: ({ upstreamMethod, upstreamCode, upstreamMessage } = {}) =>
                                `BaseLinker відхилив ${upstreamMethod || 'API-запит'}${upstreamCode ? ` (${upstreamCode})` : ''}${upstreamMessage ? `: ${upstreamMessage}` : '.'}` },
  baselinker_cursor_invalid: { status: 502, message: 'BaseLinker повернув сторінку замовлень без безпечного курсора. Завантаження зупинено, щоб не дублювати запити.' },
  baselinker_order_id_invalid: { status: 400, message: 'Некоректний BaseLinker order_id.' },
  baselinker_package_id_invalid: { status: 400, message: 'Некоректний BaseLinker package_id.' },
  baselinker_package_number_invalid: { status: 400, message: 'BaseLinker ще не повернув коректний номер ТТН для цього замовлення.' },
  baselinker_courier_code_invalid: { status: 400, message: 'Не вказано коректний код курʼєра для ТТН.' },
  baselinker_package_order_mismatch: { status: 409, message: 'Ця ТТН не належить вказаному BaseLinker order_id. Друк заблоковано.' },
  baselinker_package_courier_mismatch: { status: 409, message: 'Код курʼєра не відповідає пакуванню цього BaseLinker замовлення. Друк заблоковано.' },
  baselinker_terminal_ttn_confirmation_required: { status: 409, message: ({ disposition } = {}) => disposition === 'cancelled'
                                ? 'Замовлення анульовано в BaseLinker. Для перегляду або друку ТТН потрібне явне підтвердження користувача.'
                                : 'Замовлення вже має статус «Відправлено» в BaseLinker. Для перегляду або друку ТТН потрібне явне підтвердження користувача.' },
  baselinker_status_id_invalid: { status: 400, message: 'Некоректний BaseLinker status_id.' },
  baselinker_label_invalid: { status: 502, message: 'BaseLinker повернув порожню або некоректну ТТН.' },
  baselinker_label_too_large: { status: 502, message: 'ТТН BaseLinker перевищує безпечний ліміт розміру.' },
  baselinker_order_not_returned: { status: 404, message: ({ orderId, upstreamMethod } = {}) =>
                                `BaseLinker успішно відповів${upstreamMethod ? ` на ${upstreamMethod}` : ''}, але не повернув замовлення${orderId ? ` #${orderId}` : ''}. Воно могло бути видалене або недоступне для цього API-токена. Оновіть список і повторіть.` },
  baselinker_order_has_no_products: { status: 409, message: 'У замовленні BaseLinker немає товарних позицій для збирання.' },
  baselinker_worker_has_active_order: { status: 409, message: ({ orderId } = {}) =>
                                `У вас уже є активне замовлення${orderId ? ` #${orderId}` : ''}. Завершіть або відкладіть його перед наступним.` },
  baselinker_picking_taken: { status: 409, message: ({ ownerName } = {}) =>
                                ownerName ? `Це замовлення зараз збирає ${ownerName}.` : 'Це замовлення зараз збирає інший працівник.' },
  baselinker_picking_not_started: { status: 409, message: 'Спочатку візьміть це замовлення в роботу.' },
  baselinker_picking_not_owner: { status: 409, message: ({ ownerName } = {}) =>
                                ownerName ? `Замовлення зараз закріплено за ${ownerName}.` : 'Ви більше не є виконавцем цього замовлення. Оновіть екран.' },
  baselinker_picking_terminal: { status: 409, message: 'Це замовлення вже запаковано або відправлено. Для виправлення адміністратор має повернути його в роботу.' },
  baselinker_picking_revision_required: { status: 400, message: 'Не передано актуальну версію стану комплектування.' },
  baselinker_picking_stale: { status: 409, message: ({ currentRevision } = {}) =>
                                `Стан замовлення вже змінив інший працівник${currentRevision ? ` (версія ${currentRevision})` : ''}. Оновіть картку і повторіть.` },
  baselinker_picking_item_not_found: { status: 404, message: 'Позицію комплектування не знайдено. Можливо, склад замовлення змінився.' },
  baselinker_picking_item_state_invalid: { status: 400, message: 'Некоректний стан позиції комплектування.' },
  baselinker_picking_quantity_invalid: { status: 400, message: ({ requestedQty } = {}) =>
                                `Некоректна знайдена кількість${requestedQty != null ? `. Потрібно максимум ${requestedQty}.` : '.'}` },
  baselinker_picking_items_unhandled: { status: 409, message: ({ pendingLines } = {}) =>
                                `Ще не опрацьовано ${Number(pendingLines) || 0} позицій. Для кожної позиції відмітьте «зібрано» або зафіксуйте проблему.` },
  baselinker_order_changed: { status: 409, message: 'Замовлення змінилося в BaseLinker під час роботи. Змінені позиції скинуто на перевірку — перегляньте їх ще раз.' },
  baselinker_order_cancelled: { status: 409, message: 'Замовлення анульовано в BaseLinker. Складські зміни для нього заблоковано.' },
  baselinker_order_already_sent: { status: 409, message: 'Замовлення вже має вихідний статус BaseLinker. Складські зміни для нього заблоковано.' },
  baselinker_order_not_in_intake: { status: 409, message: ({ currentStatusId, intakeStatusId } = {}) =>
                                `Замовлення більше не перебуває у виробничому статусі BaseLinker${currentStatusId ? ` (поточний ID: ${currentStatusId})` : ''}${intakeStatusId ? `. Дозволений ID: ${intakeStatusId}` : ''}. Складські дії заблоковано до повернення у робочий статус.` },
  baselinker_order_status_unverified: { status: 409, message: 'Поточний статус замовлення в BaseLinker не підтверджено. Складські дії тимчасово заблоковано.' },
  baselinker_physical_fulfillment_immutable: { status: 409, message: 'Факт пакування або відправлення вже зафіксований складом і не може бути відкочений.' },
  baselinker_order_status_write_unverified: { status: 502, message: 'BaseLinker не підтвердив зміну точного order_id на налаштований статус «Відправлено». Локальний Sent не записано.' },
  baselinker_upstream_review_required: { status: 409, message: 'Замовлення оновилось у BaseLinker після початку збирання. Перевірте актуальні дані та підтвердьте перевірку.' },
  baselinker_picking_has_unresolved_issues: { status: 409, message: 'Замовлення має невирішені проблемні позиції. Його не можна запакувати, доки проблеми не буде закрито.' },
  baselinker_picking_not_ready_after_upstream_change: { status: 409, message: 'Після оновлення BaseLinker замовлення більше не готове до відправлення. Поверніть його в роботу та перевірте змінені позиції.' },
  baselinker_picking_not_packed: { status: 409, message: 'Спочатку підтвердьте, що замовлення запаковано.' },
  baselinker_print_agent_not_configured: { status: 503, message: 'Віддалений друк не налаштовано. Додайте BASELINKER_PRINT_AGENT_TOKEN на backend і підключіть Print Agent.' },
  print_agent_unauthorized: { status: 401, message: 'Невірний Print Agent token.' },
  baselinker_print_agent_offline: { status: 503, message: 'Print Agent зараз не в мережі. Перевірте ПК складу та програму друку.' },
  baselinker_print_agent_id_invalid: { status: 400, message: 'Некоректний Print Agent ID.' },
  baselinker_print_printer_invalid: { status: 400, message: 'Print Agent не передав коректну назву принтера.' },
  baselinker_print_job_not_found: { status: 404, message: 'Завдання друку не знайдено.' },
  baselinker_print_job_not_claimed: { status: 409, message: 'Завдання друку вже не належить цьому Print Agent або завершене.' },
  baselinker_print_job_expired: { status: 409, message: 'Завдання друку прострочене. Натисніть «ТТН» ще раз.' },

  // ── Orders ─────────────────────────────────────────────────────────────────
  order_not_found:          { status: 404, message: 'Замовлення не знайдено' },
  order_not_active:         { status: 409, message: ({ status } = {}) =>
                                `Замовлення вже ${status === 'fulfilled' ? 'виконано' : 'скасовано'} — перенос неможливий.` },
  order_picking_started:    { status: 409, message: 'Замовлення вже в роботі на складі (пакування розпочато або підготовлено). Перенос/відв’язка заборонені.' },
  order_picking_locked:     { status: 409, message: 'Замовлення зараз у активному пакуванні на складі. Дочекайтесь розблокування або підтвердження від складу.' },
  order_status_change_disabled: { status: 403, message: 'Ручна зміна статусу замовлення вимкнена. Статус змінюється лише автоматично під час збирання.' },

  // ── Auth / middleware ─────────────────────────────────────────────────────
  auth_invalid_init_data:   { status: 401, message: ({ reason } = {}) =>
                                reason === 'initData expired'
                                  ? 'Сесія Telegram застаріла. Закрийте додаток і відкрийте знову.'
                                  : reason
                                    ? `Помилка авторизації Telegram: ${reason}`
                                    : 'Невалідні дані авторизації Telegram' },
  auth_init_data_replayed: { status: 401, message: 'Не вдалося повторно підтвердити Telegram-сесію.' },
  auth_telegram_session_required: { status: 401, message: 'Сесію Telegram не знайдено.' },
  auth_telegram_session_mismatch: { status: 409, message: 'Telegram-сесія належить іншому активному акаунту.' },
  auth_telegram_session_slot_invalid: { status: 400, message: 'Некоректний Telegram session slot.' },
  auth_telegram_id_missing: { status: 400, message: 'Не передано Telegram user id' },
  auth_not_registered:      { status: 403, message: 'Користувача не зареєстровано. Зверніться до менеджера або адміністратора.' },
  // Backwards-compat alias used by mini-app client code that switches on `error` value.
  not_registered:           { status: 403, message: 'Користувача не зареєстровано. Зверніться до менеджера або адміністратора.' },
  auth_required:            { status: 401, message: 'Потрібна авторизація через Telegram' },
  auth_telegram_group_required: { status: 403, message: 'Доступ втрачено: вас немає в робочій Telegram-групі «Оголошення». Попросіть менеджера або адміністратора додати вас назад.' },
  auth_telegram_group_check_failed: { status: 503, message: 'Не вдалося підтвердити ваше членство в робочій Telegram-групі. Спробуйте ще раз через хвилину.' },
  auth_telegram_group_not_configured: { status: 503, message: 'Робочу Telegram-групу ще не налаштовано. Зверніться до адміністратора.' },

  // ── Google browser login ───────────────────────────────────────────────────
  google_auth_not_configured: { status: 503, message: 'Вхід через Google тимчасово недоступний (сервер не налаштовано).' },
  google_invalid_token:     { status: 401, message: 'Не вдалося перевірити вхід Google. Спробуйте ще раз.' },
  google_email_unverified:  { status: 403, message: 'Ваша Google-пошта не підтверджена. Підтвердьте її в акаунті Google і повторіть.' },
  google_email_not_linked:  { status: 403, message: ({ email } = {}) =>
                                `Пошту${email ? ` ${email}` : ''} не привʼязано до жодного акаунту. Відкрийте застосунок у Telegram → Профіль → «Привʼязати Google», а тоді увійдіть через Google ще раз.` },
  google_sub_taken:         { status: 409, message: 'Цей Google-акаунт уже привʼязано до іншого користувача.' },
  google_already_linked:    { status: 409, message: 'До вашого акаунта вже привʼязано інший Google. Спершу відвʼяжіть його.' },
  google_link_invalid:      { status: 400, message: 'Посилання для привʼязки недійсне або прострочене. Почніть привʼязку знову.' },

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
  product_barcode_duplicate: { status: 409, message: 'Товар з таким штрих-кодом вже існує' },
  product_order_number_conflict: { status: 409, message: 'Два підтвердження одночасно зайняли один порядковий номер. Повторіть спробу.' },
  product_filename_required:{ status: 400, message: 'Параметр filename обовʼязковий' },
  product_reorder_invalid:  { status: 400, message: 'Order має бути масивом id товарів' },
  product_broadcast_invalid:{ status: 400, message: 'productIds має бути непорожнім масивом' },
  product_only_archived_can_delete:{ status: 400, message: 'Видаляти можна лише товари зі статусом «архів»' },
  product_not_archived:     { status: 400, message: 'Товар не знаходиться в архіві' },
  product_converted_to_shop:{ status: 409, message: 'Товар уже передано в «Товари Магазинів» (понад 30 днів в архіві). Складу він більше не належить — знайдіть його в каталозі магазинів.' },
  product_photo_required:   { status: 400, message: 'Фото є обов\u02bcязковим' },
  product_quantity_invalid: { status: 400, message: 'Кількість має бути цілим числом >= 0' },
  product_required_fields:  { status: 400, message: 'Порядковий номер, ціна та кількість є обов\u02bcязковими' },
  product_order_invalid:    { status: 400, message: 'Порядковий номер має бути цілим числом більше за 0' },
  product_archive_via_delete:{ status: 400, message: 'Використовуйте DELETE для архівації товару' },
  product_block_id_invalid: { status: 400, message: 'Невірний ідентифікатор блока' },
  product_filenames_required:{ status: 400, message: 'Не вказано файли зображень' },
  shopproduct_edit_on_warehouse:{ status: 403, message: 'Цей товар належить складу й редагується на сторінці Складу. Тут він лише відображається.' },
  shopproduct_receipt_owned:  { status: 409, message: 'Цей товар створений накладною. Його маршрут і видимість змінюються через накладну, а не прямим видаленням з «Товари Магазинів».' },
  product_upload_failed_generic: { status: 500, message: 'Не вдалося завантажити' },
  telegram_groups_not_configured: { status: 500, message: 'Не налаштовано Telegram-групи для розсилок' },
  telegram_bot_not_initialized:   { status: 500, message: 'Telegram-бот не ініціалізований' },
  telegram_new_products_group_invalid: { status: 400, message: 'ID Telegram-групи «Нові Товари» має бути числом' },
  telegram_new_products_group_unavailable: { status: 422, message: 'Бот не бачить цю Telegram-групу або не має права публікувати в ній' },
  telegram_new_products_group_not_configured: { status: 409, message: 'Telegram-групу «Нові Товари» не налаштовано' },
  telegram_new_products_destination_unhealthy: { status: 409, message: 'Telegram-група «Нові Товари» зараз недоступна для нових публікацій. Перевірте бота та його право публікувати в Settings.' },
  telegram_new_products_original_photo_missing: { status: 422, message: 'Для публікації потрібне чисте оригінальне фото товару' },
  telegram_new_products_decision_invalid: { status: 400, message: 'Невірна дія для Telegram-публікації' },
  telegram_new_products_delivery_unknown: { status: 409, message: 'Telegram міг прийняти попередню публікацію, але сервер не отримав message_id. Автоматичний повтор заблоковано, щоб не створити дублікат.' },
  telegram_new_products_cleanup_pending: { status: 409, message: 'Попередній Telegram-життєвий цикл цієї позиції ще не завершено. Дочекайтеся очищення або закрийте ручну перевірку в Settings.' },
  telegram_new_products_unknown_binding_not_found: { status: 409, message: 'Невизначену Telegram-публікацію для прив’язки не знайдено.' },
  telegram_new_products_message_reference_invalid: { status: 400, message: 'Вкажіть коректні chatId і messageId Telegram-поста.' },
  telegram_bot_unavailable: { status: 503, message: 'Telegram-бот зараз недоступний.' },
  telegram_cleanup_not_found: { status: 404, message: 'Telegram cleanup-запис не знайдено або він уже завершений.' },
  telegram_cleanup_not_retryable: { status: 409, message: 'Цей Telegram cleanup неможливо повторити автоматично.' },
  search_r2_public_url_missing:   { status: 503, message: 'R2_PUBLIC_URL не сконфігуровано' },
  search_no_existing_request:     { status: 404, message: 'Запит для цього штрихкоду не знайдено' },
  search_resend_rate_limited:     { status: 429, message: 'Забагато повторних запитів для цього штрихкоду. Спробуйте пізніше' },
  search_resend_failed:           { status: 500, message: 'Не вдалося повторно надіслати запит' },
  // ── Picking ────────────────────────────────────────────────────────────────
  picking_task_not_found:         { status: 404, message: 'Завдання не знайдено' },
  picking_product_not_found:      { status: 404, message: 'Товар для збирання не знайдено (можливо, архівований або видалений)' },
  picking_current_block_invalid:  { status: 400, message: 'currentBlock має бути додатнім цілим числом' },
  picking_block_invalid:          { status: 400, message: 'blockId має бути додатнім цілим числом' },
  picking_delivery_group_required:{ status: 400, message: 'Для старту сесії збирання потрібно передати deliveryGroupId' },
  picking_session_failed:         { status: 500, message: 'Помилка запуску сесії збирання' },
  picking_session_not_found:      { status: 409, message: 'Поточну сесію збирання не знайдено' },
  picking_next_failed:            { status: 500, message: 'Помилка отримання задачі' },
  picking_block_tasks_failed:     { status: 500, message: 'Помилка отримання задач блоку' },
  picking_complete_failed:        { status: 500, message: 'Помилка завершення задачі' },
  picking_progress_failed:        { status: 500, message: 'Помилка збереження прогресу' },
  picking_claim_unavailable:      { status: 409, message: 'Завдання більше недоступне' },
  picking_claim_taken_by_other:   { status: 409, message: 'Завдання забрав інший складник' },
  picking_claim_failed:           { status: 500, message: 'Помилка призначення задачі' },
  picking_oos_failed:             { status: 500, message: 'Помилка запису «немає на складі»' },
  picking_oos_already_packed:     { status: 409, message: 'Задачу вже зібрано повністю — архівувати товар через неї не можна' },
  picking_task_items_changed:     { status: 409, message: 'Список магазинів у завданні змінився — оновіть завдання' },
  expired_lock:                   { status: 403, message: 'Завдання вже взяв інший складник або час блокування минув' },

  // ── Дозамовлення (supplement) ──────────────────────────────────────────────
  supplement_offer_not_found:  { status: 404, message: 'Дозамовлення не знайдено' },
  supplement_request_not_found:{ status: 404, message: 'Заявку не знайдено' },
  supplement_request_exists:   { status: 409, message: 'Заявка на цю позицію вже існує' },
  supplement_closed:           { status: 409, message: 'Прийом дозамовлень закрито — змінити заявку вже не можна' },
  supplement_request_locked:   { status: 409, message: 'Склад уже спакував цю заявку — змінити або скасувати її не можна' },
  supplement_wrong_group:      { status: 403, message: 'Це дозамовлення призначене іншій групі доставки' },
  supplement_not_frozen:       { status: 409, message: 'Дозамовлення ще приймає заявки — завершити його можна лише після закриття' },
  supplement_not_all_packed:   { status: 409, message: 'Не всі магазини спаковані — завершити дозамовлення не можна' },
  supplement_no_requests:      { status: 409, message: 'Жоден магазин не замовив цей товар — завершувати нічого' },
  supplement_quantity_invalid: { status: 400, message: 'Кількість має бути від 1 до 6' },
  // Одна пропозиція — один складник, інакше двоє покладуть у ту саму коробку двічі.
  supplement_locked_by_other:  { status: 409, message: ({ name } = {}) => name
                                  ? `Цей товар зараз пакує ${name}. Перехопити можна через 5 хвилин бездіяльності.`
                                  : 'Цей товар зараз пакує інший складник. Перехопити можна через 5 хвилин бездіяльності.' },
  supplement_not_claimed:      { status: 409, message: 'Спершу візьміть товар у роботу — відкрийте картку дозамовлення заново' },
  supplement_app_url_invalid: { status: 400, message: 'Вкажіть коректне HTTPS-посилання на Telegram Mini App' },
  // ── Orders ─────────────────────────────────────────────────────────────────
  order_query_forbidden:          { status: 403, message: 'Ви можете запитувати лише власні замовлення' },
  // NB: order_not_found is defined once in the first Orders block above.
  order_view_forbidden:           { status: 403, message: 'У вас немає доступу до цього замовлення' },
  order_modify_forbidden:         { status: 403, message: 'У вас немає прав змінювати це замовлення' },
  order_seller_no_status:         { status: 403, message: 'Продавці не можуть змінювати статус замовлення' },
  order_no_fields:                { status: 400, message: 'Немає коректних полів для оновлення' },
  order_invalid_initdata:         { status: 401, message: 'Некоректні або відсутні дані Telegram (initData)' },
  order_buyer_mismatch:           { status: 403, message: 'buyerTelegramId не збігається з автентифікованим користувачем' },
  order_items_required:           { status: 400, message: 'Потрібно передати коректний список товарів' },
  order_no_valid_items:           { status: 400, message: 'Не знайдено жодного коректного товару' },
  order_shop_required:            { status: 400, message: 'Не вказано shopId' },
  order_shop_not_found:           { status: 400, message: 'Магазин для замовлення не знайдено' },
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
  receipt_log_fetch_failed: { status: 500, message: 'Не вдалося отримати журнал' },
  receipt_log_failed:       { status: 500, message: 'Не вдалося записати лог' },
  receipt_qty_invalid:      { status: 400, message: 'Кількість, що приїхала, має бути додатнім цілим числом' },
  receipt_bulk_empty:       { status: 400, message: 'Оберіть хоча б одне фото товару' },
  receipt_bulk_too_large:   { status: 400, message: 'За один раз можна додати не більше 100 фото' },
  receipt_bulk_batch_invalid:{ status: 400, message: 'Некоректний ідентифікатор масового завантаження' },
  receipt_log_action_required: { status: 400, message: 'Поле action обовʼязкове' },

  // ── Receipts (multi-worker) ────────────────────────────────────────────────
  receipt_item_forbidden_edit: { status: 403, message: 'Редагувати прийомку можуть лише працівники складу та адміністратори.' },
  receipt_item_forbidden_delete: { status: 403, message: 'Видалити позицію може лише працівник, який її додав' },
  receipt_item_forbidden_confirm: { status: 403, message: 'Підтвердити позицію можуть лише працівники складу та адміністратори.' },
  receipt_item_already_confirmed: { status: 409, message: 'Підтверджену позицію видалити може лише адміністратор.' },
  receipt_item_not_confirmed_yet: { status: 409, message: 'Позиція ще не підтверджена' },
  receipt_items_not_all_confirmed: { status: 409, message: ({ pending } = {}) =>
                                `Не всі позиції підтверджені (${pending ?? '?'} без підпису). Підтвердіть усі позиції перед проведенням.` },
  receipt_item_incomplete: { status: 422, message: ({ fields } = {}) =>
                                `Щоб підтвердити позицію, заповніть: ${fields || 'усі обовʼязкові поля'}.` },
  receipt_item_not_prepared: { status: 422, message: ({ fields } = {}) =>
                                `Перед вибором маршруту заповніть: ${fields || 'ціну та кількість в упаковці'}.` },
  receipt_routing_batch_empty: { status: 400, message: 'Оберіть хоча б один товар для пакетного маршруту' },
  receipt_routing_batch_too_large: { status: 400, message: 'За один раз можна обробити не більше 100 товарів' },
  receipt_routing_batch_draft_only: { status: 409, message: 'Пакетний маршрут доступний лише для товарів, які ще не підтверджені' },
  receipt_routing_batch_regular_only: { status: 409, message: 'Пакетний маршрут недоступний для старих накладних-дозамовлень' },
  receipt_routing_batch_blocked: { status: 409, message: ({ reasons } = {}) =>
                                `Пакетну зміну не виконано. Жоден товар не змінено.${reasons ? ` ${reasons}` : ''}` },
  receipt_supplement_already_completed: { status: 409, message: 'Дозамовлення цього товару вже виконано. Це завершений історичний факт: зняти або повторно увімкнути «Дозамовлення» через накладну не можна.' },
  receipt_destination_required: { status: 400, message: 'Вкажіть призначення: «Склад» або «Магазини»' },
  receipt_route_required: { status: 422, message: 'Оберіть, куди піде товар: «На склад», «Обовʼязковий» або «Дозамовлення»' },
  receipt_route_conflict: { status: 422, message: '«Обовʼязковий» і «Дозамовлення» не можна вибрати одночасно' },
  receipt_route_warning_requires_mandatory: { status: 422, message: 'Позначка «Може приїхати не всім» доступна лише для обовʼязкового товару' },
  receipt_route_warning_with_warehouse: { status: 422, message: '«Може приїхати не всім» не поєднується з «На склад»: якщо після обовʼязкової роздачі є залишок на склад, обовʼязковим магазинам товару вистачило' },
  receipt_route_locked: { status: 409, message: 'Маршрут підтвердженої позиції не змінюється напряму. Спочатку зніміть підтвердження.' },
  receipt_remainder_not_supported_legacy: { status: 409, message: 'Додавання залишку на склад доступне лише для нового підтвердженого маршруту товару.' },
  receipt_remainder_route_invalid: { status: 422, message: 'Залишок можна додати на склад після «Обовʼязковий» або «Дозамовлення».' },
  receipt_remainder_product_failed: { status: 500, message: 'Не вдалося додати залишок товару на склад.' },

  // ── Тип накладної (звичайна / дозамовлення) ────────────────────────────────
  receipt_type_invalid:     { status: 400, message: 'Невідомий тип накладної' },
  receipt_type_locked:      { status: 409, message: 'Тип накладної можна змінити лише поки в ній немає жодної позиції' },
  receipt_not_supplement:   { status: 400, message: 'Ця накладна не є накладною на дозамовлення' },
  receipt_supplement_shelf_only: { status: 400, message:
                                'У накладній на дозамовлення всі товари йдуть на склад — призначення «Магазини» тут неможливе' },
  // Хвиля вже пішла продавцям: ціну/кількість правити можна, а підміняти саму
  // світлину товару — ні, інакше магазин замовляв одне, а приїде інше.
  receipt_supplement_photo_locked: { status: 409, message:
                                'Дозамовлення вже відкрито — світлину товару змінити не можна. ' +
                                'Ціну, кількість і коментар правити можна (підписи на фото перемалюються).' },
  receipt_supplement_wave_closed: { status: 409, message:
                                'Прийом заявок на це дозамовлення вже закрито — нову позицію додати нікому' },
  receipt_supplement_route_open: { status: 409, message:
                                'Дозамовлення цього товару зараз відкрите для продавців. Спочатку закрийте прийом заявок («Передати в роботу»), після цього маршрут можна змінити.' },
  supplement_target_required: { status: 400, message: 'Оберіть групу доставки, для якої відкрити дозамовлення' },
  supplement_target_not_found:{ status: 404, message: 'Обрану групу доставки більше не існує — оновіть список і виберіть іншу' },
  supplement_wave_not_found: { status: 404, message: 'Хвилю дозамовлення не знайдено' },
  supplement_item_already_published: { status: 409, message: 'Цей товар уже опубліковано в іншому дозамовленні для цієї групи.' },
  supplement_wave_items_incomplete: { status: 500, message: 'Не вдалося повністю відкрити дозамовлення. Спробуйте ще раз.' },
  supplement_target_session_not_started: { status: 409, message: ({ group } = {}) =>
    `${group || 'Ця група'} ще не має поточної активної сесії доставки` },
  supplement_target_session_changed: { status: 409, message: ({ group } = {}) =>
    `Поточна сесія ${group || 'групи'} змінилася — оновіть список і підтвердьте ще раз` },
  supplement_target_session_completed: { status: 409, message: ({ group } = {}) =>
    `Поточна доставка ${group || 'цієї групи'} вже завершена` },
  supplement_pack_before_freeze: { status: 409, message: 'Спочатку закрийте дозамовлення і передайте його в роботу' },
  supplement_item_cancelled: { status: 409, message: 'Цей товар у дозамовленні скасовано' },
  product_supplement_session_only: { status: 409, message: 'Цей товар у поточній доставці доступний через дозамовлення, а не через звичайне замовлення' },
  supplement_ordering_still_open: { status: 409, message: ({ group } = {}) =>
                                `У групі «${group || 'без назви'}» звичайна сесія замовлень ще відкрита. Дозамовлення відкриваємо тільки після її закриття.` },
  // Після hard-guard на ordering_open єдина додаткова причина відмови —
  // показувати хвилю нікому. Збирання після закриття ordering не блокує target.
  supplement_target_no_shops: { status: 409, message: ({ group } = {}) =>
                                `У групі «${group || 'без назви'}» немає активних магазинів — дозамовлення нікому показувати` },

  // ── Blocks (extra) ─────────────────────────────────────────────────────────
  block_id_conflict:        { status: 409, message: 'Конфлікт ID блока, повторіть спробу' },
  block_create_failed:      { status: 500, message: 'Не вдалося створити блок' },
  block_list_failed:        { status: 500, message: 'Не вдалося отримати список блоків' },
  block_fetch_failed:       { status: 500, message: 'Не вдалося отримати блок' },
  block_not_empty:          { status: 409, message: 'Видалити можна лише порожній блок' },
  block_delete_tail_only:   { status: 409, message: ({ maxBlockId } = {}) => maxBlockId
                                ? `Щоб не створити дірку в нумерації, спочатку видаліть останній блок #${maxBlockId}.`
                                : 'Видаляти блоки можна лише з кінця послідовності.' },
  block_search_query_required:{ status: 400, message: 'Не вказано пошуковий запит' },

  // ── Admin / OpenAI / cities ────────────────────────────────────────────────
  openai_connection_failed: { status: 500, message: ({ reason } = {}) => reason
                                ? `Не вдалося підключитися до OpenAI: ${reason}`
                                : 'Не вдалося підключитися до OpenAI' },
  openai_models_failed:     { status: 500, message: 'Не вдалося отримати список моделей OpenAI' },
  me_shop_required:         { status: 400, message: 'shopId є обовʼязковим' },
  me_profile_no_changes:    { status: 400, message: 'Немає змін для збереження' },
  profile_email_invalid:    { status: 400, message: 'Невірний формат email у профілі' },
  profile_email_taken:      { status: 409, message: 'Цю Google-пошту вже привʼязано до іншого акаунту' },
  me_state_invalid_index:   { status: 400, message: ({ field } = {}) =>
                                `Поле «${field || 'currentIndex'}» має бути цілим невідʼємним числом` },
  init_data_required:       { status: 400, message: 'Відсутні дані Telegram (initData)' },
  registration_not_in_group: { status: 403, message: 'Вас ще немає в групі «Оголошення». Попросіть менеджера або адміністратора додати вас до групи.' },
  registration_group_check_failed: { status: 503, message: 'Не вдалося перевірити, чи ви є в групі «Оголошення». Спробуйте ще раз.' },
  registration_group_not_configured: { status: 503, message: 'Реєстрацію ще не налаштовано. Напишіть менеджеру або адміністратору.' },
  registration_token_invalid: { status: 403, message: 'Ця кнопка більше не працює. Почніть реєстрацію знову.' },
  registration_pending:     { status: 403, message: 'Ваші дані надіслано адміністратору. Вам більше нічого робити не потрібно.' },
  registration_blocked:     { status: 403, message: ({ reason = '' } = {}) => reason
                                ? `Реєстрацію зупинено адміністратором. Причина: ${reason}`
                                : 'Реєстрацію зупинено адміністратором. Зверніться до адміністратора, щоб дізнатися причину.' },
  registration_rejected:    { status: 403, message: ({ reason = '' } = {}) => reason
                                ? `Реєстрацію не підтверджено. Причина: ${reason}`
                                : 'Реєстрацію не підтверджено. Ви можете виправити дані та надіслати їх ще раз.' },
  registration_required_fields: { status: 400, message: 'Вкажіть ваше імʼя та прізвище.' },
  registration_invalid_role:{ status: 400, message: 'Оберіть, ким ви працюєте.' },
  registration_seller_shop_required: { status: 400, message: 'Оберіть магазин.' },
  registration_email_invalid: { status: 400, message: 'Невірний формат email у заявці' },
  registration_email_taken: { status: 409, message: 'Цю Google-пошту вже привʼязано до іншого акаунту в системі' },
  registration_shop_inactive: { status: 400, message: 'Цей магазин зараз недоступний. Оберіть інший магазин або напишіть адміністратору.' },
  registration_shop_no_group: { status: 400, message: 'Цей магазин ще не готовий до роботи. Напишіть адміністратору.' },
  registration_group_not_found: { status: 400, message: 'Для цього магазину не знайдено групу доставки. Напишіть адміністратору.' },
  registration_request_exists: { status: 409, message: 'Ваші дані вже надіслано адміністратору. Вам більше нічого робити не потрібно.' },
  registration_user_exists: { status: 409, message: 'Ви вже зареєстровані. Оновіть сторінку.' },
  registration_not_found:   { status: 404, message: 'Заявку на реєстрацію не знайдено' },
  registration_not_pending: { status: 409, message: 'Заявка вже оброблена (схвалена/відхилена/заблокована)' },
  registration_status_invalid: { status: 400, message: 'Невірний фільтр статусу заявок' },
  registration_reason_required: { status: 400, message: 'Вкажіть коротку причину для користувача.' },
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
  transfer_target_in_conflict:  { status: 409, message: 'Цільовий магазин уже в стані конфлікту (декілька продавців або замовлень). Спочатку вирішіть конфлікт у розділі конфліктів, потім повторіть перенесення.' },
  conflict_resolve_invalid:     { status: 400, message: 'Некоректні параметри вирішення конфлікту' },
  conflict_seller_not_found:    { status: 404, message: 'Продавця конфлікту не знайдено' },
  conflict_target_required:     { status: 400, message: 'Потрібно вказати цільовий магазин для перенесення' },
  conflict_target_same_shop:    { status: 400, message: 'Оберіть інший магазин — продавець уже прив’язаний до цього магазину' },
  cleared_cart_not_found:       { status: 404, message: 'Видалений кошик не знайдено' },
  cleared_cart_already_restored:{ status: 409, message: 'Цей кошик уже відновлено' },
  restore_no_shop:              { status: 409, message: 'Продавець не призначений до магазину — відновлення неможливе' },
  restore_window_closed:        { status: 409, message: 'Сесія замовлення закрита і не відкриється протягом 4 годин. Відновіть кошик, коли вікно замовлення відкрите або відкриється найближчим часом.' },
  restore_cart_conflict:        { status: 409, message: 'У продавця вже є товари в кошику. Вкажіть mode: "replace" або "merge".' },

  // ── Shops (extra) ──────────────────────────────────────────────────────────
  shop_list_failed:         { status: 500, message: 'Не вдалося отримати список магазинів' },
  shop_cities_failed:       { status: 500, message: 'Не вдалося отримати список міст (модуль магазинів)' },
  shop_fetch_failed:        { status: 500, message: 'Не вдалося отримати магазин' },
  no_shop:                  { status: 403, message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.' },
  no_delivery_group:        { status: 403, message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.' },
  delivery_group_not_found: { status: 403, message: 'Групу доставки не знайдено.' },
  shop_name_required:       { status: 400, message: 'name є обовʼязковим' },
  shop_city_required:       { status: 400, message: 'cityId є обовʼязковим' },
  shop_delivery_group_required:{ status: 400, message: 'deliveryGroupId є обовʼязковим' },
  shop_city_not_found:      { status: 400, message: 'Місто магазину не знайдено' },
  shop_delivery_group_not_found:{ status: 400, message: 'Групу доставки для магазину не знайдено' },
  shop_create_failed:       { status: 500, message: 'Не вдалося створити магазин' },
  shop_update_failed:       { status: 500, message: 'Не вдалося оновити магазин' },
  shop_invite_failed:       { status: 500, message: 'Не вдалося згенерувати посилання на магазин' },

  // ── Delivery groups (extra) ────────────────────────────────────────────────
  group_name_or_day_required:{ status: 400, message: 'Поля name, dayOfWeek та orderingSchedule обовʼязкові' },
  group_schedule_invalid: { status: 400, message: ({ reason } = {}) => `Некоректний розклад групи${reason ? `: ${reason}` : ''}` },
  group_no_members:         { status: 400, message: 'Група не має учасників' },
  group_broadcast_failed:   { status: 500, message: 'Не вдалося надіслати розсилку' },
  group_day_change_session_active: { status: 409, message: ({ reason } = {}) =>
                                `Не можна застосувати цей розклад (${reason || 'зміна зачіпає використану сесію'}). ` +
                                'Активні замовлення, незавершене збирання або повторне відкриття вже завершеного циклу захищені. ' +
                                'Завершені замовлення й completed-задачі самі по собі редагування не блокують.' },
  shop_group_change_session_active: { status: 409, message: ({ reason } = {}) =>
                                `Не можна змінити групу доставки магазину під час активної сесії (${reason || 'цикл у процесі'}). ` +
                                'Поточні замовлення прив\'язані до сесії старої групи — переніс лишив би їх застряглими. ' +
                                'Змініть групу після завершення поточного циклу.' },
  shop_deactivate_session_active: { status: 409, message: ({ reason } = {}) =>
                                `Не можна деактивувати магазин зараз (${reason || 'є незавершена робота поточного циклу'}). ` +
                                'Спочатку завершіть або скасуйте його поточне замовлення/дозамовлення.' },
};

// ─── Dev-time integrity guard ────────────────────────────────────────────────
// A JS object literal silently keeps only the LAST of duplicate keys, so a
// repeated error code would vanish without any warning (and the wrong message /
// status would be served). Scan this file's own source at load time and fail
// fast on duplicates; advise on identical messages that make client-side
// triage ambiguous.
(function assertErrorDictionaryIntegrity() {
  try {
    const src = require('fs').readFileSync(__filename, 'utf8');
    const start = src.indexOf('const ERRORS = {');
    const body = src.slice(start, src.indexOf('\n};', start));
    const re = /^ {2}([a-z0-9_]+):\s*\{/gm;
    const seen = new Set();
    const dups = new Set();
    let m;
    while ((m = re.exec(body))) {
      if (seen.has(m[1])) dups.add(m[1]);
      seen.add(m[1]);
    }
    if (dups.size) {
      throw new Error(`[errors.js] Duplicate error codes (silently overwritten): ${[...dups].join(', ')}`);
    }
    // Intentional alias pairs where a shared message is by design (client
    // switches on the `error` code, not the text).
    const INTENTIONAL_ALIASES = new Set(['auth_not_registered|not_registered']);
    const byMsg = new Map();
    for (const [k, v] of Object.entries(ERRORS)) {
      if (typeof v.message !== 'string') continue;
      byMsg.set(v.message, [...(byMsg.get(v.message) || []), k]);
    }
    for (const [msg, ks] of byMsg) {
      if (ks.length > 1 && !INTENTIONAL_ALIASES.has([...ks].sort().join('|'))) {
      }
    }
  } catch (e) {
    if (/Duplicate error codes/.test(e.message)) throw e; // fatal — real bug
     // scan is best-effort
  }
})();

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

  // Mongoose validation. Schema internals are useful to staff while debugging,
  // but exposing raw validator paths/messages to sellers or unauthenticated
  // callers gives away unnecessary model structure.
  if (err && err.name === 'ValidationError') {
    const payload = {
      error: 'validation_failed',
      message: t('validation_failed'),
    };
    if (['admin', 'warehouse'].includes(req?.telegramUser?.role)) payload.details = err.message;
    return res.status(400).json(payload);
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

  // Transient transaction conflict (two requests raced on the SAME documents and the
  // optimistic-retry budget was exhausted). It is a "try again", NOT a server fault —
  // answer 409 so the client can retry, instead of a scary 500.
  const txLabels = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
  if (err && (err.code === 112 || err.codeName === 'WriteConflict'
      || txLabels.includes('TransientTransactionError')
      || (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')))) {
    return res.status(409).json({
      error: 'conflict_retry',
      message: 'Конфлікт одночасних змін. Спробуйте ще раз.',
    });
  }

  // Upstream client errors that already carry a 4xx HTTP status must NOT be masked
  // as 500. Most important: a malformed percent-encoded URL path (e.g. "%%%") makes
  // Express throw a URIError with status 400; a bad JSON body makes body-parser throw
  // an entity.parse.failed error with status 400. A "random button / garbage link"
  // must answer 400, not crash to 500.
  const upstreamStatus = err && (err.status || err.statusCode);
  if (Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 500) {
    return res.status(upstreamStatus).json({
      error: err.type || 'bad_request',
      message: t('validation_failed'),
    });
  }

  return res.status(500).json({
    error: 'internal_error',
    message: t('internal_error'),
  });
}

module.exports = { AppError, appError, t, asyncHandler, errorHandler, ERRORS };
