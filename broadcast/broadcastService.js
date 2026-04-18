/**
 * Broadcast service — orchestrates mass photo delivery.
 *
 * Usage:
 *   const { startBroadcast, getBroadcastStats } = require('./broadcast/broadcastService');
 *
 *   // Start a broadcast: send all active products to all sellers
 *   await startBroadcast();
 *
 *   // Or with custom options
 *   await startBroadcast({ productFilter: { status: 'active' }, recipientRole: 'seller' });
 */
const crypto = require('crypto');
const Product = require('../models/Product');
const User = require('../models/User');
const { imageQueue, sendQueue } = require('./queues');

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || (process.env.NODE_ENV === 'production' ? null : `http://localhost:${process.env.PORT || 5000}`);

function getPhotoUrl(photoUrl) {
  if (!photoUrl) return null;
  if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) return photoUrl;
  if (!SERVER_BASE_URL) {
    throw new Error('SERVER_BASE_URL must be configured in production to build absolute photo URLs');
  }
  return `${SERVER_BASE_URL.replace(/\/+$/, '')}/${photoUrl.replace(/^\/+/, '')}`;
}

/**
 * Start a broadcast.
 *
 * @param {Object} options
 * @param {Object}  options.productFilter   - Mongoose filter for products (default: { status: 'active' })
 * @param {string}  options.recipientRole   - Role of recipients (default: 'seller')
 * @param {string[]} options.recipientIds   - Specific telegram IDs (overrides role filter)
 * @param {boolean} options.addLabels       - Whether to add price/qty labels (default: true)
 * @returns {{ broadcastId: string, totalJobs: number }}
 */
async function startBroadcast(options = {}) {
  const {
    productFilter = { status: 'active' },
    recipientRole = 'seller',
    recipientIds,
    addLabels = true,
  } = options;

  const broadcastId = crypto.randomUUID();

  // 1. Fetch products
  const products = await Product.find(productFilter).sort({ orderNumber: 1 }).lean();
  // Filter out incomplete products (no image or price 0)
  const validProducts = products.filter(
    (p) => p.price > 0 && (p.imageUrls?.length > 0 || p.telegramFileId)
  );
  if (!validProducts.length) throw new Error('No products found for broadcast');

  // 2. Fetch recipients
  let recipients;
  if (recipientIds?.length) {
    recipients = recipientIds;
  } else {
    const users = await User.find({ role: recipientRole }).lean();
    recipients = users.map((u) => u.telegramId).filter(Boolean);
  }
  if (!recipients.length) throw new Error('No recipients found for broadcast');

  // 3. Enqueue image processing jobs (one per product)
  const imageJobs = validProducts.map((product) => {
    // Determine image source — prioritize imageUrls (always fresh) over telegramFileId (may be stale)
    let imageSource;
    if (product.imageUrls?.length) {
      imageSource = { type: 'url', value: getPhotoUrl(product.imageUrls[0]) };
    } else if (product.telegramFileId) {
      imageSource = { type: 'telegramFileId', value: product.telegramFileId };
    } else {
      imageSource = null;
    }

    return {
      name: `image-${broadcastId}-${product._id}`,
      data: {
        broadcastId,
        productId: String(product._id),
        imageSource,
        price: addLabels ? product.price : null,
        quantityPerPackage: addLabels ? product.quantityPerPackage : null,
        caption: `Ціна: ${product.price} zł`,
        recipients,
      },
    };
  });

  // Filter out products with no image that still need to be sent as text
  const withImages = imageJobs.filter((j) => j.data.imageSource);
  const withoutImages = imageJobs.filter((j) => !j.data.imageSource);

  // Enqueue image jobs in bulk
  if (withImages.length) {
    await imageQueue.addBulk(withImages);
  }

  // For products without images, enqueue send jobs directly (text-only)
  if (withoutImages.length) {
    const textSendJobs = [];
    for (const job of withoutImages) {
      for (const chatId of recipients) {
        textSendJobs.push({
          name: `send-${broadcastId}-${job.data.productId}-${chatId}`,
          data: {
            chatId,
            caption: job.data.caption,
            broadcastId,
            productId: job.data.productId,
            // No photo — sendWorker will send as text message
          },
        });
      }
    }
    if (textSendJobs.length) {
      await sendQueue.addBulk(textSendJobs);
    }
  }

  const totalMessages = validProducts.length * recipients.length;

  console.log(`[Broadcast] ${broadcastId} started: ${validProducts.length} products × ${recipients.length} recipients = ${totalMessages} messages (${products.length - validProducts.length} skipped)`);

  return {
    broadcastId,
    productsCount: validProducts.length,
    recipientsCount: recipients.length,
    totalMessages,
  };
}

/**
 * Get live stats for the broadcast queues.
 */
async function getBroadcastStats() {
  const [imgWaiting, imgActive, imgCompleted, imgFailed] = await Promise.all([
    imageQueue.getWaitingCount(),
    imageQueue.getActiveCount(),
    imageQueue.getCompletedCount(),
    imageQueue.getFailedCount(),
  ]);

  const [sendWaiting, sendActive, sendCompleted, sendFailed, sendDelayed] = await Promise.all([
    sendQueue.getWaitingCount(),
    sendQueue.getActiveCount(),
    sendQueue.getCompletedCount(),
    sendQueue.getFailedCount(),
    sendQueue.getDelayedCount(),
  ]);

  return {
    image: { waiting: imgWaiting, active: imgActive, completed: imgCompleted, failed: imgFailed },
    send: {
      waiting: sendWaiting,
      active: sendActive,
      completed: sendCompleted,
      failed: sendFailed,
      delayed: sendDelayed,
    },
    totalDelivered: sendCompleted,
    totalFailed: sendFailed,
    inProgress: imgActive + sendActive + imgWaiting + sendWaiting + sendDelayed,
  };
}

/**
 * Drain all broadcast queues (cancel pending broadcast).
 */
async function cancelBroadcast() {
  await imageQueue.drain();
  await sendQueue.drain();
  console.log('[Broadcast] All queues drained');
  return { cancelled: true };
}

module.exports = { startBroadcast, getBroadcastStats, cancelBroadcast };
