/* eslint-disable no-console */

/**
 * Broken image audit
 *
 * READ ONLY:
 * - нічого не змінює в MongoDB
 * - рекурсивно шукає URL зображень
 * - перевіряє original / image / photo / thumbnail / preview / product images
 * - HEAD -> fallback GET
 * - показує 404 та інші HTTP/network помилки
 * - зберігає повний JSON-звіт
 *
 * Запуск:
 *   node scripts/audit-broken-images.js
 *
 * ENV:
 *   MONGODB_URI=mongodb://...
 *   MONGODB_DB=...
 *
 * Опціонально:
 *   IMAGE_AUDIT_CONCURRENCY=10
 *   IMAGE_AUDIT_TIMEOUT_MS=10000
 */

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL;

const DB_NAME =
  process.env.MONGODB_DB ||
  process.env.MONGO_DB ||
  process.env.DB_NAME;

const CONCURRENCY = Math.max(
  1,
  Number(process.env.IMAGE_AUDIT_CONCURRENCY || 10)
);

const TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.IMAGE_AUDIT_TIMEOUT_MS || 10000)
);

if (!MONGODB_URI) {
  console.error(
    "❌ Немає MONGODB_URI / MONGO_URI / DATABASE_URL у environment."
  );
  process.exit(1);
}

/**
 * Ключі, які явно схожі на зображення.
 *
 * Навмисно широкий список — аудит діагностичний.
 */
const IMAGE_KEY_RE =
  /(?:image|images|img|photo|photos|picture|pictures|thumbnail|thumb|preview|original|gallery|media|icon|cover)/i;

/**
 * Розширення, які майже напевно означають картинку.
 */
const IMAGE_EXT_RE =
  /\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?|svg)(?:[?#].*)?$/i;

function isHttpUrl(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\/[^\s]+$/i.test(value.trim())
  );
}

function looksLikeImageUrl(value, fieldPath = "") {
  if (!isHttpUrl(value)) return false;

  const url = value.trim();

  // Поле саме говорить, що це image/photo/thumb/original...
  if (IMAGE_KEY_RE.test(fieldPath)) return true;

  // Або URL має очевидне image-розширення.
  if (IMAGE_EXT_RE.test(url)) return true;

  return false;
}

function extractImageUrls(value, currentPath = "", result = []) {
  if (value == null) {
    return result;
  }

  if (typeof value === "string") {
    if (looksLikeImageUrl(value, currentPath)) {
      result.push({
        path: currentPath || "<root>",
        url: value.trim(),
      });
    }

    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      extractImageUrls(
        item,
        `${currentPath}[${index}]`,
        result
      );
    });

    return result;
  }

  if (
    typeof value === "object" &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  ) {
    for (const [key, nestedValue] of Object.entries(value)) {
      const nextPath = currentPath
        ? `${currentPath}.${key}`
        : key;

      extractImageUrls(nestedValue, nextPath, result);
    }
  }

  return result;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "ZlotoweczkaWarehouse-ImageAudit/1.0",
        Accept: "image/*,*/*;q=0.8",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkImage(url) {
  const startedAt = Date.now();

  try {
    let response;

    /*
     * Спочатку HEAD, щоб не качати картинки.
     */
    try {
      response = await fetchWithTimeout(url, {
        method: "HEAD",
      });
    } catch {
      response = null;
    }

    /*
     * Частина CDN / серверів не підтримує HEAD,
     * тому перевіряємо маленьким GET.
     */
    if (
      !response ||
      response.status === 405 ||
      response.status === 403 ||
      response.status === 400 ||
      response.status >= 500
    ) {
      response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          Range: "bytes=0-1023",
        },
      });
    }

    const contentType =
      response.headers.get("content-type") || "";

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.url || url,
      redirected: response.redirected,
      contentType,
      isImageContentType:
        /^image\//i.test(contentType),
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      statusText: null,
      finalUrl: url,
      redirected: false,
      contentType: null,
      isImageContentType: false,
      durationMs: Date.now() - startedAt,
      error:
        error?.name === "AbortError"
          ? `TIMEOUT after ${TIMEOUT_MS} ms`
          : error?.message || String(error),
    };
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    {
      length: Math.min(limit, items.length),
    },
    worker
  );

  await Promise.all(workers);

  return results;
}

function classifyProblem(check) {
  if (check.status === 404) return "HTTP_404";
  if (check.status === 403) return "HTTP_403";
  if (check.status === 401) return "HTTP_401";
  if (check.status === 410) return "HTTP_410";
  if (check.status && check.status >= 500) {
    return "HTTP_5XX";
  }

  if (check.error) {
    if (/timeout/i.test(check.error)) {
      return "TIMEOUT";
    }

    return "NETWORK_ERROR";
  }

  if (!check.ok) {
    return `HTTP_${check.status || "UNKNOWN"}`;
  }

  if (
    check.contentType &&
    !check.isImageContentType
  ) {
    return "NOT_IMAGE_CONTENT_TYPE";
  }

  return null;
}

async function main() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  console.log("🔌 Підключення до MongoDB...");

  await client.connect();

  try {
    const db = DB_NAME
      ? client.db(DB_NAME)
      : client.db();

    console.log(`✅ DB: ${db.databaseName}`);

    const collections = await db
      .listCollections({}, { nameOnly: true })
      .toArray();

    console.log(
      `📦 Колекцій: ${collections.length}`
    );

    const references = [];

    for (const { name: collectionName } of collections) {
      /*
       * Системні колекції не чіпаємо.
       */
      if (collectionName.startsWith("system.")) {
        continue;
      }

      console.log(
        `\n🔍 Сканую ${collectionName}...`
      );

      const collection = db.collection(collectionName);

      let documentCount = 0;
      let referenceCount = 0;

      const cursor = collection.find(
        {},
        {
          noCursorTimeout: true,
        }
      );

      for await (const document of cursor) {
        documentCount++;

        const found = extractImageUrls(document);

        for (const item of found) {
          references.push({
            collection: collectionName,
            documentId:
              document._id != null
                ? String(document._id)
                : null,
            field: item.path,
            url: item.url,
          });

          referenceCount++;
        }
      }

      console.log(
        `   документи: ${documentCount}, image refs: ${referenceCount}`
      );
    }

    console.log(
      `\n🖼️ Всього посилань на зображення: ${references.length}`
    );

    /*
     * Один URL може використовуватись у десятках документів.
     * HTTP-запит робимо лише один раз на унікальний URL.
     */
    const uniqueUrls = [
      ...new Set(references.map((item) => item.url)),
    ];

    console.log(
      `🌍 Унікальних URL для HTTP-перевірки: ${uniqueUrls.length}`
    );

    let checked = 0;

    const checks = await mapLimit(
      uniqueUrls,
      CONCURRENCY,
      async (url) => {
        const result = await checkImage(url);

        checked++;

        const problem = classifyProblem(result);

        const prefix = problem
          ? "❌"
          : "✅";

        console.log(
          `${prefix} [${checked}/${uniqueUrls.length}] ` +
            `${result.status ?? "ERR"} ${url}` +
            (problem ? ` → ${problem}` : "")
        );

        return {
          url,
          ...result,
          problem,
        };
      }
    );

    const checkByUrl = new Map(
      checks.map((item) => [item.url, item])
    );

    const detailed = references.map((ref) => ({
      ...ref,
      ...(checkByUrl.get(ref.url) || {}),
    }));

    const broken = detailed.filter(
      (item) => item.problem
    );

    const notFound = detailed.filter(
      (item) => item.status === 404
    );

    const uniqueBrokenUrls = new Set(
      broken.map((item) => item.url)
    );

    const unique404Urls = new Set(
      notFound.map((item) => item.url)
    );

    console.log("\n========================================");
    console.log("IMAGE AUDIT SUMMARY");
    console.log("========================================");

    console.log(
      `Image references:          ${references.length}`
    );

    console.log(
      `Unique image URLs:         ${uniqueUrls.length}`
    );

    console.log(
      `Broken references:         ${broken.length}`
    );

    console.log(
      `Unique broken URLs:        ${uniqueBrokenUrls.size}`
    );

    console.log(
      `404 references:            ${notFound.length}`
    );

    console.log(
      `Unique 404 URLs:           ${unique404Urls.size}`
    );

    if (broken.length) {
      console.log(
        "\n\n🚨 БИТІ ЗОБРАЖЕННЯ\n"
      );

      for (const item of broken) {
        console.log("----------------------------------------");
        console.log(`Problem:    ${item.problem}`);
        console.log(`HTTP:       ${item.status ?? "-"}`);
        console.log(`Collection: ${item.collection}`);
        console.log(`Document:   ${item.documentId}`);
        console.log(`Field:      ${item.field}`);
        console.log(`URL:        ${item.url}`);

        if (
          item.finalUrl &&
          item.finalUrl !== item.url
        ) {
          console.log(
            `Final URL:  ${item.finalUrl}`
          );
        }

        if (item.error) {
          console.log(`Error:      ${item.error}`);
        }
      }
    }

    const reportDir = path.resolve(
      process.cwd(),
      "tmp"
    );

    fs.mkdirSync(reportDir, {
      recursive: true,
    });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const fullPath = path.join(
      reportDir,
      `image-audit-${timestamp}.json`
    );

    const brokenPath = path.join(
      reportDir,
      `broken-images-${timestamp}.json`
    );

    fs.writeFileSync(
      fullPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: db.databaseName,
          summary: {
            references: references.length,
            uniqueUrls: uniqueUrls.length,
            brokenReferences: broken.length,
            uniqueBrokenUrls: uniqueBrokenUrls.size,
            notFoundReferences: notFound.length,
            unique404Urls: unique404Urls.size,
          },
          results: detailed,
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      brokenPath,
      JSON.stringify(broken, null, 2)
    );

    console.log("\n📄 Звіти:");
    console.log(`   FULL:   ${fullPath}`);
    console.log(`   BROKEN: ${brokenPath}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("\n❌ IMAGE AUDIT FAILED");
  console.error(error);
  process.exit(1);
});