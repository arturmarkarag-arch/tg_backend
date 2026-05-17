const crypto = require('crypto');
const sharp = require('sharp');

// Single source of truth for image processing. Every product photo that enters
// the system is normalized here into two JPEG variants:
//   - main:  max 1200px on the long side  → lists' detail / fullscreen view
//   - thumb: max 240px  on the long side  → list / grid / tile previews
// `.rotate()` (no args) applies the EXIF orientation and strips it, so photos
// taken on phones are always upright and metadata-free.

const MAIN_MAX = 1200;
const THUMB_MAX = 240;

async function buildImageVariants(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error('empty_image_buffer');
  }

  const filename = `${crypto.randomUUID()}.jpg`;

  const [main, thumb] = await Promise.all([
    sharp(inputBuffer)
      .rotate()
      .resize(MAIN_MAX, MAIN_MAX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer(),
    sharp(inputBuffer)
      .rotate()
      .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer(),
  ]);

  return { filename, main, thumb };
}

module.exports = { buildImageVariants, MAIN_MAX, THUMB_MAX };
