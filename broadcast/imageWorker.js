/**
 * Image processing worker.
 *
 * Receives jobs with product data, fetches the original image,
 * applies Sharp labels (price + quantity), compresses to JPEG 80%,
 * and enqueues one send-job per recipient in SEND_QUEUE.
 *
 * Job data:
 *   { productId, imageSource, price, quantityPerPackage, caption, recipients: [chatId, ...], broadcastId }
 *
 * imageSource can be:
 *   - { type: 'url', value: '<url>' }
 *   - { type: 'buffer', value: '<base64>' }
 *   - { type: 'telegramFileId', value: '<fileId>' }
 */
const { Worker } = require('bullmq');
const sharp = require('sharp');
const { redisOpts } = require('./connection');
const { sendQueue, IMAGE_QUEUE_NAME } = require('./queues');

function buildLabelSvg(width, height, price, quantityPerPackage) {
  const fontSize = Math.round(height * 0.07);
  const padding = Math.round(fontSize * 0.4);
  const rx = 12;

  function makeLabel(text, yTop) {
    const chars = String(text).length;
    const textW = Math.round(chars * fontSize * 0.62);
    const boxW = textW + padding * 2;
    const boxH = fontSize + padding;
    const x = Math.round(width * 0.04);
    return `<rect x="${x}" y="${yTop}" width="${boxW}" height="${boxH}" rx="${rx}" fill="white"/>
      <text x="${x + padding}" y="${yTop + fontSize - Math.round(padding * 0.2)}"
        font-family="DejaVu Sans,Arial,sans-serif" font-weight="bold" font-size="${fontSize}px" fill="black">${text}</text>`;
  }

  const topY = Math.round(height * 0.04);
  const boxH2 = fontSize + padding;
  const bottomY = Math.round(height * 0.96) - boxH2;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${makeLabel(`${price} zł`, topY)}
    ${makeLabel(`${quantityPerPackage} шт`, bottomY)}
  </svg>`;
}

async function fetchImageBuffer(imageSource, botToken) {
  if (imageSource.type === 'buffer') {
    return Buffer.from(imageSource.value, 'base64');
  }
  if (imageSource.type === 'url') {
    const res = await fetch(imageSource.value, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Fetch failed: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (imageSource.type === 'telegramFileId') {
    // The send worker will use file_id directly — no processing needed.
    // But if we need to add labels, we must download via Bot API first.
    const localApiBase = process.env.TELEGRAM_LOCAL_API_URL;
    let fileUrl;
    if (localApiBase) {
      // Local Bot API: GET /bot<token>/getFile
      const fileRes = await fetch(`${localApiBase}/bot${botToken}/getFile?file_id=${imageSource.value}`);
      const fileData = await fileRes.json();
      if (!fileData.ok) throw new Error(`getFile failed: ${JSON.stringify(fileData)}`);
      fileUrl = `${localApiBase}/file/bot${botToken}/${fileData.result.file_path}`;
    } else {
      const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${imageSource.value}`);
      const fileData = await fileRes.json();
      if (!fileData.ok) throw new Error(`getFile failed: ${JSON.stringify(fileData)}`);
      fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
    }
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`File download failed: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`Unknown imageSource type: ${imageSource.type}`);
}

let imageWorker = null;

function startImageWorker() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  imageWorker = new Worker(
    IMAGE_QUEUE_NAME,
    async (job) => {
      const { imageSource, price, quantityPerPackage, caption, recipients, broadcastId, productId } = job.data;

      let processedBuffer;

      // If it's a telegramFileId and we DON'T need labels, skip Sharp — send file_id directly
      const needsLabels = price != null && quantityPerPackage != null;
      let useTelegramFileId = false;

      if (imageSource.type === 'telegramFileId' && !needsLabels) {
        useTelegramFileId = true;
      } else {
        // Fetch + process with Sharp
        const rawBuffer = await fetchImageBuffer(imageSource, botToken);

        if (needsLabels) {
          const meta = await sharp(rawBuffer).metadata();
          const labelSvg = buildLabelSvg(meta.width, meta.height, price, quantityPerPackage);
          processedBuffer = await sharp(rawBuffer)
            .composite([{ input: Buffer.from(labelSvg), top: 0, left: 0 }])
            .jpeg({ quality: 80, mozjpeg: true })
            .toBuffer();
        } else {
          // Just compress
          processedBuffer = await sharp(rawBuffer)
            .jpeg({ quality: 80, mozjpeg: true })
            .toBuffer();
        }
      }

      // Enqueue one send job per recipient
      const sendJobs = recipients.map((chatId) => ({
        name: `send-${broadcastId}-${productId}-${chatId}`,
        data: {
          chatId,
          caption: caption || '',
          broadcastId,
          productId,
          ...(useTelegramFileId
            ? { telegramFileId: imageSource.value }
            : { photoBase64: processedBuffer.toString('base64') }),
        },
      }));

      // Bulk-add to send queue (efficient)
      await sendQueue.addBulk(sendJobs);

      return { enqueued: sendJobs.length };
    },
    {
      ...redisOpts,
      concurrency: 4,   // process up to 4 images in parallel
      limiter: { max: 20, duration: 1000 },
    },
  );

  imageWorker.on('failed', (job, err) => {
    console.error(`[ImageWorker] Job ${job?.id} failed:`, err.message);
  });

  imageWorker.on('error', (err) => {
    console.error('[ImageWorker] Worker error:', err);
  });

  return imageWorker;
}

function getImageWorker() {
  return imageWorker;
}

module.exports = { startImageWorker, getImageWorker };
