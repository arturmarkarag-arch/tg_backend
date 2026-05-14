'use strict';

/**
 * Field usage audit script.
 * Run: node server/scripts/audit-fields.js
 *
 * For every Mongoose model, checks:
 *  1. What % of documents in the real DB have each field non-null/non-empty
 *  2. Whether the field appears in any source file (routes/ services/ utils/)
 */

const path = require('path');
const fs   = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');

// ── models ───────────────────────────────────────────────────────────────────
const models = {
  ActivityLog:         require('../models/ActivityLog'),
  AppSetting:          require('../models/AppSetting'),
  Block:               require('../models/Block'),
  BotInteractionLog:   require('../models/BotInteractionLog'),
  BotSession:          require('../models/BotSession'),
  City:                require('../models/City'),
  Counter:             require('../models/Counter'),
  DeliveryGroup:       require('../models/DeliveryGroup'),
  Order:               require('../models/Order'),
  PickingTask:         require('../models/PickingTask'),
  Product:             require('../models/Product'),
  Receipt:             require('../models/Receipt'),
  ReceiptItem:         require('../models/ReceiptItem'),
  ReceiptItemLog:      require('../models/ReceiptItemLog'),
  RegistrationRequest: require('../models/RegistrationRequest'),
  SearchProduct:       require('../models/SearchProduct'),
  Shop:                require('../models/Shop'),
  ShopTransferRequest: require('../models/ShopTransferRequest'),
  User:                require('../models/User'),
};

// ── source dirs to scan for field references ─────────────────────────────────
const SOURCE_DIRS = [
  path.resolve(__dirname, '../routes'),
  path.resolve(__dirname, '../services'),
  path.resolve(__dirname, '../utils'),
  path.resolve(__dirname, '../telegramBot.js'),
];

function collectSourceFiles(dirs) {
  const files = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const stat = fs.statSync(d);
    if (stat.isFile()) { files.push(d); continue; }
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isFile() && f.endsWith('.js')) files.push(full);
    }
  }
  return files;
}

function buildSourceIndex(files) {
  // Returns combined source text (large string — fast for includes checks)
  return files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

function isFieldInSource(fieldName, source) {
  // Match field as object property: .fieldName  or ['fieldName'] or "fieldName": or fieldName:
  const patterns = [
    new RegExp(`\\.${fieldName}\\b`),
    new RegExp(`\\['${fieldName}'\\]`),
    new RegExp(`\\["${fieldName}"\\]`),
    new RegExp(`['"]${fieldName}['"]\\s*:`),
    new RegExp(`\\b${fieldName}\\s*:`),
  ];
  return patterns.some(p => p.test(source));
}

function getSchemaTopLevelPaths(model) {
  const paths = [];
  model.schema.eachPath((pathName) => {
    const top = pathName.split('.')[0];
    if (!paths.includes(top) && top !== '__v' && top !== '_id') {
      paths.push(top);
    }
  });
  return paths;
}

async function getFieldFillRate(collection, fieldName, total) {
  if (total === 0) return null;
  const count = await collection.countDocuments({
    [fieldName]: { $exists: true, $ne: null, $ne: '' },
  });
  return Math.round((count / total) * 100);
}

function fillBar(pct) {
  if (pct === null) return '  n/a  ';
  const filled = Math.round(pct / 10);
  return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']';
}

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to MongoDB\n');

  const sourceFiles = collectSourceFiles(SOURCE_DIRS);
  const source = buildSourceIndex(sourceFiles);
  console.log(`Scanned ${sourceFiles.length} source files for field references.\n`);

  const RESET  = '\x1b[0m';
  const RED    = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const GREEN  = '\x1b[32m';
  const BOLD   = '\x1b[1m';
  const DIM    = '\x1b[2m';

  const deadFields   = [];
  const unusedInCode = [];
  const report = { generatedAt: new Date().toISOString(), models: {} };

  for (const [modelName, Model] of Object.entries(models)) {
    const collection = Model.collection;
    const total = await collection.countDocuments();
    const fields = getSchemaTopLevelPaths(Model);

    console.log(`${BOLD}━━━ ${modelName} ${DIM}(${total} documents)${RESET}`);

    if (total === 0) {
      console.log(`  ${DIM}Collection is empty — model may be unused${RESET}\n`);
      report.models[modelName] = { total: 0, empty: true, fields: [] };
      continue;
    }

    report.models[modelName] = { total, fields: [] };

    for (const field of fields) {
      const pct = await getFieldFillRate(collection, field, total);
      const inCode = isFieldInSource(field, source);
      const bar = fillBar(pct);

      const isDead    = pct !== null && pct === 0;
      const isSparse  = pct !== null && pct > 0 && pct < 5;
      const notInCode = !inCode;

      let color = GREEN;
      let status = 'ok';
      let flag  = '';

      if (isDead && notInCode) {
        color = RED; status = 'dead';
        flag  = '  ← 🔴 DEAD (0% fill + not in code)';
        deadFields.push(`${modelName}.${field}`);
      } else if (isDead) {
        color = RED; status = 'empty';
        flag  = '  ← 🔴 0% fill (check if still needed)';
      } else if (notInCode) {
        color = YELLOW; status = 'not_in_code';
        flag  = '  ← ⚠️  not found in source code';
        unusedInCode.push(`${modelName}.${field}`);
      } else if (isSparse) {
        color = YELLOW; status = 'sparse';
        flag  = '  ← ⚠️  very sparse';
      }

      report.models[modelName].fields.push({ field, fillPct: pct, inCode, status });

      const pctStr = pct === null ? '---' : `${String(pct).padStart(3)}%`;
      console.log(`  ${color}${bar} ${pctStr}  ${field}${flag}${RESET}`);
    }
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${BOLD}━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

  if (deadFields.length) {
    console.log(`\n${RED}${BOLD}Dead fields (0% in DB AND not referenced in code):${RESET}`);
    deadFields.forEach(f => console.log(`  ${RED}• ${f}${RESET}`));
  }

  if (unusedInCode.length) {
    console.log(`\n${YELLOW}${BOLD}Fields not found in source code (but have data in DB):${RESET}`);
    unusedInCode.forEach(f => console.log(`  ${YELLOW}• ${f}${RESET}`));
  }

  if (!deadFields.length && !unusedInCode.length) {
    console.log(`\n${GREEN}No obviously dead fields found.${RESET}`);
  }

  // ── Save files ────────────────────────────────────────────────────────────
  report.summary = { deadFields, unusedInCode };

  const outDir  = path.resolve(__dirname, '../../audit-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const jsonPath = path.join(outDir, 'field-audit.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Build HTML report
  const rows = [];
  for (const [modelName, data] of Object.entries(report.models)) {
    if (data.empty) {
      rows.push(`<tr class="empty"><td colspan="4"><b>${modelName}</b> — колекція порожня</td></tr>`);
      continue;
    }
    rows.push(`<tr class="model-header"><td colspan="4"><b>${modelName}</b> (${data.total} документів)</td></tr>`);
    for (const f of data.fields) {
      const pct = f.fillPct === null ? '—' : `${f.fillPct}%`;
      const bar = f.fillPct === null ? '' : `<div class="bar"><div class="fill" style="width:${f.fillPct}%"></div></div>`;
      const statusClass = f.status === 'ok' ? 'ok' : f.status === 'dead' ? 'dead' : f.status === 'empty' ? 'empty-field' : 'warn';
      const statusLabel = { ok: '✓', dead: '🔴 DEAD', empty: '🔴 0% fill', not_in_code: '⚠️ не в коді', sparse: '⚠️ sparse' }[f.status] || '';
      rows.push(`<tr class="${statusClass}">
        <td class="model-name"></td>
        <td class="field-name">${f.field}</td>
        <td>${bar} ${pct}</td>
        <td>${statusLabel}</td>
      </tr>`);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<title>Field Audit Report</title>
<style>
  body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
  h1 { color: #00d4ff; }
  p.meta { color: #888; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #16213e; color: #00d4ff; padding: 8px 12px; text-align: left; }
  td { padding: 5px 12px; border-bottom: 1px solid #222; }
  tr.model-header td { background: #0f3460; color: #fff; padding-top: 14px; }
  tr.empty td { background: #0f3460; color: #888; font-style: italic; }
  tr.dead td { background: #3d0000; color: #ff6b6b; }
  tr.empty-field td { background: #2a1a1a; color: #ff9999; }
  tr.warn td { background: #2a2200; color: #ffd93d; }
  tr.ok td { color: #6bcf7f; }
  .bar { display:inline-block; width:100px; height:10px; background:#333; vertical-align:middle; border-radius:3px; overflow:hidden; }
  .fill { height:100%; background:#00d4ff; }
  .field-name { font-weight: bold; }
  .summary { margin-top: 30px; }
  .summary h2 { color: #ff6b6b; }
  .summary ul { color: #ffd93d; }
</style>
</head>
<body>
<h1>📊 Field Audit Report</h1>
<p class="meta">Згенеровано: ${report.generatedAt}</p>
<table>
  <thead><tr><th>Модель</th><th>Поле</th><th>Заповненість</th><th>Статус</th></tr></thead>
  <tbody>${rows.join('\n')}</tbody>
</table>
<div class="summary">
  <h2>🔴 Мертві поля (0% в БД + відсутні в коді)</h2>
  <ul>${deadFields.map(f => `<li>${f}</li>`).join('') || '<li>Не знайдено</li>'}</ul>
  <h2 style="color:#ffd93d">⚠️ Поля відсутні в коді (але є дані в БД)</h2>
  <ul>${unusedInCode.map(f => `<li>${f}</li>`).join('') || '<li>Не знайдено</li>'}</ul>
</div>
</body>
</html>`;

  const htmlPath = path.join(outDir, 'field-audit.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  console.log(`\n${BOLD}Файли збережено:${RESET}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  HTML: ${htmlPath}`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
