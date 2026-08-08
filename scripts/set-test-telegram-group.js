const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env'),
});

const mongoose = require('mongoose');
const AppSetting = require('../models/AppSetting');

const GROUP_ID = process.argv[2];

async function main() {
  if (!GROUP_ID || !/^-?\d+$/.test(GROUP_ID)) {
    throw new Error(
      'Вкажи group ID. Приклад: node scripts/set-test-telegram-group.js -1001234567890'
    );
  }

  const uri = process.env.MONGODB_URI || '';

  // HARD GUARD — цей скрипт дозволено запускати тільки на TEST Mongo.
  if (!uri.includes('epfky0s.mongodb.net')) {
    throw new Error(
      `STOP: це не TEST MongoDB. Поточний host: ${uri.replace(/\/\/.*@/, '//***@')}`
    );
  }

  await mongoose.connect(uri);

  const before = await AppSetting.findOne({
    key: 'telegram.allowedGroupIds',
  }).lean();

  console.log('Було:', before?.value ?? '(немає запису)');

  const updated = await AppSetting.findOneAndUpdate(
    { key: 'telegram.allowedGroupIds' },
    {
      $set: {
        // Для TEST навмисно ЗАМІНЮЄМО список,
        // щоб production/старі групи не заважали тестовому боту.
        value: [String(GROUP_ID)],
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  ).lean();

  console.log('Стало:', updated.value);

  await mongoose.disconnect();

  console.log('OK — TEST telegram.allowedGroupIds оновлено.');
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});