import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
function check(name, fn) { try { fn(); passed += 1; console.log(`PASS ${name}`); } catch (e) { process.exitCode = 1; console.error(`FAIL ${name}: ${e.message}`); } }
const data = read('src/features/baseLinker/hooks/useBaseLinkerData.js');
const settings = read('src/routes/settings/BaseLinkerSettingsBlock.jsx');
const page = read('src/routes/BaseLinkerPage.jsx');
const api = read('src/api.js');
const keys = read('src/query/queryKeys.js');
const shift = read('src/routes/ShiftBoardPage.jsx');

check('BaseLinker pages are not speculatively prefetched', () => {
  assert(!data.includes('prefetchQuery'));
  assert(!data.includes('useQueryClient'));
});
check('API request meter lives only in BaseLinker settings and polls our backend every 5 seconds', () => {
  assert(settings.includes('refetchInterval: 5_000'));
  assert(settings.includes('getBaseLinkerApiUsage'));
  assert(settings.includes('Запити 60с:'));
  assert(api.includes("request('/baselinker/api-usage'"));
});
check('main BaseLinker page has no standalone API usage panel', () => {
  assert(!page.includes('BaseLinkerApiUsagePanel'));
  assert(!page.includes('BaseLinker API · останні 60 секунд'));
});
check('request meter has its own stable TanStack query key', () => {
  assert(keys.includes("apiUsage: ['baselinker', 'api-usage']"));
});
check('shift Telegram history starts only after seller disclosure is opened', () => {
  assert(shift.includes('enabled: open && Boolean(deliveryGroupId && seller.telegramId)'));
  assert(shift.includes('getShiftSellerNotifications'));
  assert(api.includes('/picking/shift-board/seller-notifications'));
});
check('main shift board still has independent lightweight polling', () => {
  assert(shift.includes('refetchInterval: 15_000'));
  assert(keys.includes('sellerNotifications:'));
});

console.log(`\n${passed}/6 frontend BaseLinker request-efficiency checks passed`);
if (process.exitCode) process.exit(process.exitCode);
