'use strict';

/**
 * Temporary real-worker session controller.
 *
 * Purpose:
 *   Let real sellers place orders in the current session, then temporarily make
 *   ONE delivery group appear closed so warehouse staff can start picking now.
 *
 * It does NOT change orders or orderingSessionId. It selects another temporary
 * dayOfWeek whose current session has the SAME openDate, so getOrCreateSessionId
 * resolves to the same OrderingSession document.
 *
 * Commands:
 *   node scripts/testSessionControl.js status
 *   node scripts/testSessionControl.js close
 *   node scripts/testSessionControl.js restore
 *
 * Default groupId: 69def1d9db8e774832fb0b7f
 * Override when needed with --groupId=<id>.
 *
 * You may use --groupName="Monday group" instead of --groupId.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_GROUP_ID = '69def1d9db8e774832fb0b7f';

// Lightweight .env loader without the external `dotenv` package.
// Existing environment variables always win.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    if (
      value.length >= 2 &&
      ((value.startsWith('\"') && value.endsWith('\"')) ||
       (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  return true;
}

if (process.env.NODE_ENV !== 'production') {
  // Prefer .env in the backend root: <backend>/scripts -> <backend>/.env
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
  ];
  for (const candidate of candidates) {
    if (loadEnvFile(candidate)) break;
  }
}

let mongoose;
try {
  mongoose = require('mongoose');
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND') {
    console.error('❌ Не знайдено залежності backend-проєкту. Запусти в корені backend: npm install');
    process.exit(1);
  }
  throw error;
}
const DeliveryGroup = require('../models/DeliveryGroup');
const Order = require('../models/Order');
const AppSetting = require('../models/AppSetting');
const OrderingSession = require('../models/OrderingSession');
const cache = require('../utils/cache');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const {
  isOrderingOpen,
  getOpenDateWarsaw,
  getOrderingWindowOpenAt,
} = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');

function parseArgs(argv) {
  const [action = 'status', ...rest] = argv;
  const args = { action };
  for (const item of rest) {
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq === -1) args[item.slice(2)] = true;
    else args[item.slice(2, eq)] = item.slice(eq + 1);
  }
  return args;
}

function backupKey(groupId) {
  return `test.session-control.${String(groupId)}`;
}

async function findGroup(args) {
  const groupId = args.groupId || DEFAULT_GROUP_ID;
  if (groupId) return DeliveryGroup.findById(String(groupId));
  if (args.groupName) {
    const escaped = String(args.groupName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = await DeliveryGroup.find({ name: { $regex: `^${escaped}$`, $options: 'i' } });
    if (matches.length > 1) {
      throw new Error(`Знайдено кілька груп з назвою "${args.groupName}". Використай --groupId.`);
    }
    return matches[0] || null;
  }
  throw new Error('Вкажи --groupId=<MongoId> або --groupName="Назва групи".');
}

async function describe(group, schedule) {
  const gid = String(group._id);
  const status = isOrderingOpen(Number(group.dayOfWeek), schedule);
  const openDate = getOpenDateWarsaw(Number(group.dayOfWeek), schedule);
  const sessionId = await getOrCreateSessionId(gid, Number(group.dayOfWeek), schedule);
  const session = await OrderingSession.findById(sessionId).lean();
  const activeOrders = await Order.countDocuments({
    'buyerSnapshot.deliveryGroupId': gid,
    orderingSessionId: sessionId,
    status: { $in: ['new', 'in_progress'] },
  });
  return {
    groupId: gid,
    groupName: group.name,
    dayOfWeek: Number(group.dayOfWeek),
    isOpen: status.isOpen,
    message: status.message,
    openDate,
    openAt: getOrderingWindowOpenAt(Number(group.dayOfWeek), schedule).toISOString(),
    sessionId,
    pickingStatus: session?.pickingStatus || 'pending',
    activeOrders,
  };
}

async function invalidateGroupCaches() {
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
}

async function commandStatus(group, schedule) {
  const info = await describe(group, schedule);
  const backup = await AppSetting.findOne({ key: backupKey(group._id) }).lean();
  console.log(JSON.stringify({ ...info, temporaryOverride: backup?.value || null }, null, 2));
}

async function commandClose(group, schedule) {
  const gid = String(group._id);
  const existingBackup = await AppSetting.findOne({ key: backupKey(gid) }).lean();
  if (existingBackup?.value) {
    console.log('Тимчасове закриття вже активне:');
    console.log(JSON.stringify(existingBackup.value, null, 2));
    await commandStatus(group, schedule);
    return;
  }

  const before = await describe(group, schedule);
  if (!before.isOpen) {
    console.log('Група вже закрита за звичайним розкладом. Нічого змінювати не потрібно.');
    console.log(JSON.stringify(before, null, 2));
    return;
  }

  if (before.pickingStatus !== 'pending') {
    throw new Error(
      `Збирання цієї сесії вже має статус "${before.pickingStatus}". ` +
      'Повторне тестове закриття не потрібне.',
    );
  }

  // Find a CLOSED day that resolves to the exact same session openDate.
  // This preserves the stable OrderingSession ID and all existing orders.
  const candidates = [];
  for (let day = 0; day < 7; day += 1) {
    const candidateStatus = isOrderingOpen(day, schedule);
    const candidateOpenDate = getOpenDateWarsaw(day, schedule);
    if (!candidateStatus.isOpen && candidateOpenDate === before.openDate) {
      candidates.push({ day, message: candidateStatus.message });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      'Не знайдено безпечного тимчасового дня, який уже закритий і має той самий openDate. ' +
      'Скрипт нічого не змінив. У цьому випадку потрібен повноцінний manual-close override у коді.',
    );
  }

  // Prefer today's/nearest semantic candidate by choosing the first. The hard
  // invariant is same openDate; we verify session ID after the DB update.
  const candidate = candidates[0];

  const backup = {
    createdAt: new Date().toISOString(),
    groupId: gid,
    groupName: group.name,
    originalDayOfWeek: Number(group.dayOfWeek),
    temporaryDayOfWeek: candidate.day,
    originalOpenDate: before.openDate,
    originalSessionId: before.sessionId,
    activeOrdersAtClose: before.activeOrders,
  };

  const mongoSession = await mongoose.connection.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await AppSetting.updateOne(
        { key: backupKey(gid) },
        { $set: { key: backupKey(gid), value: backup } },
        { upsert: true, session: mongoSession },
      );
      await DeliveryGroup.updateOne(
        { _id: group._id, dayOfWeek: Number(group.dayOfWeek) },
        { $set: { dayOfWeek: candidate.day } },
        { session: mongoSession },
      );
    });
  } finally {
    mongoSession.endSession();
  }

  await invalidateGroupCaches();

  const updated = await DeliveryGroup.findById(group._id);
  const after = await describe(updated, schedule);

  if (after.sessionId !== before.sessionId || after.openDate !== before.openDate || after.isOpen) {
    // Roll back immediately if the invariant failed.
    await DeliveryGroup.updateOne({ _id: group._id }, { $set: { dayOfWeek: backup.originalDayOfWeek } });
    await AppSetting.deleteOne({ key: backupKey(gid) });
    await invalidateGroupCaches();
    throw new Error(
      'Перевірка безпеки не пройшла, зміни автоматично відкочено. ' +
      `beforeSession=${before.sessionId}, afterSession=${after.sessionId}, afterOpen=${after.isOpen}`,
    );
  }

  console.log('✅ Групу тимчасово закрито для тесту складу.');
  console.log('Замовлення та orderingSessionId не змінено.');
  console.log(JSON.stringify({ before, after, backup }, null, 2));
  console.log('\nТепер склад може натиснути «Розпочати збирання».');
  console.log('Не запускай restore до завершення тесту збирання.');
}

async function commandRestore(group, schedule) {
  const gid = String(group._id);
  const backupDoc = await AppSetting.findOne({ key: backupKey(gid) }).lean();
  const backup = backupDoc?.value;
  if (!backup) {
    console.log('Активного тестового переведення для цієї групи немає.');
    await commandStatus(group, schedule);
    return;
  }

  await DeliveryGroup.updateOne(
    { _id: group._id },
    { $set: { dayOfWeek: Number(backup.originalDayOfWeek) } },
  );
  await AppSetting.deleteOne({ key: backupKey(gid) });
  await invalidateGroupCaches();

  const restored = await DeliveryGroup.findById(group._id);
  const info = await describe(restored, schedule);
  console.log('✅ Оригінальний день групи відновлено.');
  console.log(JSON.stringify({ restored: info, backup }, null, 2));

  if (info.isOpen && info.pickingStatus !== 'completed') {
    console.warn(
      '\n⚠️ УВАГА: після відновлення звичайний розклад знову вважає вікно відкритим, ' +
      'а збирання ще не completed. Продавці можуть знову побачити можливість замовляти. ' +
      'Для сьогоднішнього сценарію відновлюй день тільки після завершення тесту або після природного закриття вікна.',
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowed = new Set(['status', 'close', 'restore']);
  if (!allowed.has(args.action)) {
    throw new Error(`Невідома команда "${args.action}". Доступні: status, close, restore.`);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI не заданий у середовищі або .env.');

  await mongoose.connect(uri);
  const group = await findGroup(args);
  if (!group) throw new Error('Групу доставки не знайдено.');

  const schedule = await getOrderingSchedule();

  if (args.action === 'status') await commandStatus(group, schedule);
  if (args.action === 'close') await commandClose(group, schedule);
  if (args.action === 'restore') await commandRestore(group, schedule);
}

main()
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.connection.close(); } catch { /* noop */ }
  });
