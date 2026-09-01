# Telegram «Нові Товари» — release gate report

Date: 2026-09-01

## Verdict

**Code/static architecture gate: PASS.**

The dedicated Telegram publication ledger now has no known critical/high lifecycle defects from the original 70-scenario audit. The old embedded ReceiptItem state is compatibility/migration input only; runtime authority is the dedicated Publication/Binding/Event/Destination ledger.

## Executed gates

### Server

- `node scripts/checkTelegramNewProductsArchitecture20260901.js` → **62/62 PASS**
- `node --check` over every server `.js` file (excluding `node_modules`) → **356/356 PASS**

The architecture gate checks, among other things:

- per-item lock on publish/delete/unconfirm/send;
- confirmed-source rechecks;
- atomic Binding+Publication create preparation;
- fail-closed create recovery;
- durable ambiguous cleanup;
- old ambiguity blocker before another physical generation;
- exact vs ambiguous issue counting;
- transactional failure transitions;
- destination transaction/revision/retarget;
- historical binding membership health;
- exact canonical route signature;
- symbolic Telegram errors including `MESSAGE_ID_INVALID`;
- cached `file_id` fallback;
- request timeout < item lock TTL;
- batch budget < global lane TTL;
- startup legacy migration and issue-counter repair;
- no runtime writes back to embedded `ReceiptItem.telegramNewProduct`.

### Client

- `node scripts/checkTelegramNewProductsUi20260901.mjs` → **28/28 PASS**
- TypeScript parser over all `client/src/**/*.{js,jsx}` → **253/253 PASS**

The UI gate checks:

- missing → direct republish independent from Save;
- explicit first Publish;
- stale sent and stale pending payload → Sync;
- unknown attach/reconciliation flow;
- cleanup and historical-ambiguity blockers;
- destination-health messaging;
- actionable photo/access/config blockers;
- Settings retry/manual resolve/identify/absent reconciliation controls;
- required API methods.

## Existing unrelated repository issue

Parsing **all** client scripts also encounters an existing syntax error in:

`client/scripts/checkDataStateArchitectureV48_19.mjs`

The same file in the user's original `client(20260901-172033).zip` is byte-identical and already fails `node --check` with `SyntaxError: missing ) after argument list`. It was not introduced or modified by this Telegram lifecycle work and was intentionally not silently changed as part of this scope.

## Not independently executed in this environment

The supplied archives do not contain a runnable installed dependency tree. Repeated `npm ci` attempts in this environment timed out before a usable Vitest/Vite installation was produced. Therefore this report **does not claim**:

- full server Vitest suite PASS;
- full client Vitest suite PASS;
- production Vite build PASS;
- live Telegram Bot API E2E PASS.

Those remain normal deploy-environment checks.

## Scenario result

See `docs/audits/2026-09-01-telegram-new-products-final-70-scenario-gate.md`.

Result: **67 PASS / 3 documented external-library limitations / 0 FAIL**.

The three limitations are:

1. current media-edit path can still depend on a fetchable canonical original photo URL;
2. manual Telegram caption edits are unsupported by policy and may be overwritten by app verification/update;
3. Telegram itself can refuse automatic deletion (for example an old message), in which case the durable lifecycle becomes `manual_required` with retry/manual-resolution controls.

None of these is treated as silent success or lost state.
