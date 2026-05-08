/**
 * normalize-cities.js
 * Нормалізує shops-export.json: варіанти міст → канонічні польські назви.
 * Зберігає результат у shops-export-normalized.json.
 *
 * Запуск: node scripts/normalize-cities.js
 * Показати тільки diff: node scripts/normalize-cities.js --dry-run
 */

const fs = require('fs');
const path = require('path');

// ─── Маппінг: raw → канонічна назва ──────────────────────────────────────────
const CITY_MAP = {
  // Chełm
  'Chelm':                    'Chełm',
  'Chełm':                    'Chełm',

  // Kraków
  'Krakow':                   'Kraków',
  'Kraków':                   'Kraków',
  'Краків':                   'Kraków',

  // Legionowo
  'Legionowo':                'Legionowo',

  // Lublin
  'Lublin':                   'Lublin',
  'Люблин':                   'Lublin',
  'Люблін':                   'Lublin',

  // Łódź
  'Łódź':                     'Łódź',
  'Лодзь':                    'Łódź',

  // Opole
  'Opole':                    'Opole',
  'Ополе':                    'Opole',

  // Rzeszów
  'Rzeczow':                  'Rzeszów',
  'Rzeshow':                  'Rzeszów',
  'Rzeszów':                  'Rzeszów',

  // Warszawa
  'Warszawa':                 'Warszawa',
  'Warzsawa':                 'Warszawa',
  'Варшава':                  'Warszawa',

  // Wołomin (є "Wołomin 2" — видаляємо суфікс, бо різниці в логістиці немає)
  'Wołomin 2':                'Wołomin',

  // Wrocław
  'Wroclaw':                  'Wrocław',
  'Wrocław':                  'Wrocław',
  'Вроцлав':                  'Wrocław',

  // Ziębice
  'Ziebice':                  'Ziębice',

  // Rzeszów alias
  'Rzeczów':                  'Rzeszów',

  // Решта — українські назви → польські
  'Бжег':                     'Brzeg',
  'Гродзиск Мазовецький':     'Grodzisk Mazowiecki',
  'Зомбки':                   'Ząbki',
  'Зомбковіце':               'Ząbkowice Śląskie',
  'Олава':                    'Oława',
  'Плоцьк':                   'Płock',
  'Плоцьк 2':                 'Płock',
  'Познань':                  'Poznań',
  'Прушків':                  'Pruszków',
  'Радзимін':                 'Radzymin',
  'Седльце':                  'Siedlce',
  'Урсус':                    'Warszawa',  // Урсус — район Варшави
};

// ─── Допоміжна: нормалізувати одне місто ─────────────────────────────────────
function normalizeCity(raw) {
  const trimmed = String(raw || '').trim();
  return CITY_MAP[trimmed] ?? trimmed;
}

// ─── Основна логіка ───────────────────────────────────────────────────────────
const dryRun = process.argv.includes('--dry-run');
const inputFile  = path.join(__dirname, 'shops-export.json');
const outputFile = path.join(__dirname, 'shops-export-normalized.json');

if (!fs.existsSync(inputFile)) {
  console.error(`❌ Файл не знайдено: ${inputFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
let changedCount = 0;
const diff = [];

const normalized = data.map((row) => {
  const rawCity   = String(row.shopCity  || '').trim();
  const rawName   = String(row.shopName  || '').trim();
  const rawFirst  = String(row.firstName || '').trim();
  const rawLast   = String(row.lastName  || '').trim();

  const canonCity = normalizeCity(rawCity);
  const changed   = canonCity !== rawCity;

  if (changed) {
    changedCount++;
    diff.push({
      telegramId: row.telegramId,
      seller:     `${rawFirst} ${rawLast}`.trim(),
      shopName:   rawName,
      before:     rawCity,
      after:      canonCity,
    });
  }

  return {
    ...row,
    shopName:  rawName,
    shopCity:  canonCity,
    firstName: rawFirst,
    lastName:  rawLast,
  };
});

// Виводимо diff
if (diff.length === 0) {
  console.log('✅ Всі міста вже нормалізовані, змін немає.');
} else {
  console.log(`\n📋 Зміни (${diff.length}):\n`);
  for (const d of diff) {
    console.log(`  ${d.seller} / ${d.shopName}`);
    console.log(`    "${d.before}" → "${d.after}"`);
  }
}

// Унікальні міста після нормалізації
const uniqueCities = [...new Set(normalized.map((r) => r.shopCity).filter(Boolean))].sort();
console.log(`\n🏙️  Унікальних міст після нормалізації: ${uniqueCities.length}`);
uniqueCities.forEach((c) => console.log(`  ${c}`));

if (dryRun) {
  console.log('\n⚠️  Dry-run: файл не збережено. Запусти без --dry-run щоб зберегти.');
  process.exit(0);
}

fs.writeFileSync(outputFile, JSON.stringify(normalized, null, 2), 'utf-8');
console.log(`\n✅ Збережено: ${outputFile} (${normalized.length} записів)`);
