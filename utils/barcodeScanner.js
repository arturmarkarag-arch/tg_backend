const sharp = require('sharp');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, RGBLuminanceSource, InvertedLuminanceSource, BinaryBitmap, HybridBinarizer } = require('@zxing/library');

function normalizeBarcode(text) {
  return String(text || '').replace(/\D/g, '').trim();
}

async function decodeBarcodeFromImageBuffer(imageBuffer) {
  const formats = [
    BarcodeFormat.EAN_8,
    BarcodeFormat.EAN_13,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.ITF,
    BarcodeFormat.CODABAR,
    BarcodeFormat.QR_CODE,
  ];

  const attempts = [
    { rotate: 0, invert: false },
    { rotate: 90, invert: false },
    { rotate: 270, invert: false },
    { rotate: 0, invert: true },
  ];

  for (const attempt of attempts) {
    try {
      const { data, info } = await sharp(imageBuffer)
        .rotate(attempt.rotate)
        .resize({ width: 1200, height: 1200, fit: 'inside' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (!data || !info || !info.width || !info.height) continue;
      const reader = new MultiFormatReader();
      reader.setHints(new Map([
        [DecodeHintType.POSSIBLE_FORMATS, formats],
        [DecodeHintType.TRY_HARDER, true],
      ]));

      const luminances = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
      const source = new RGBLuminanceSource(luminances, info.width, info.height);
      const luminanceSource = attempt.invert ? new InvertedLuminanceSource(source) : source;
      const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
      const result = reader.decode(binaryBitmap);
      const text = String(result?.getText() || '').trim();
      const format = String(result?.getBarcodeFormat?.()?.toString?.() || result?.getBarcodeFormat || 'UNKNOWN');
      if (text) {
        return { text, format };
      }
    } catch (error) {
      // Ignore and try next attempt.
    }
  }

  return { text: '', format: 'UNKNOWN' };
}

module.exports = {
  decodeBarcodeFromImageBuffer,
  normalizeBarcode,
};
