const sharp = require('sharp');

/**
 * Unit tests for broadcast pure functions.
 * These don't require Redis or MongoDB.
 */

// Re-implement buildLabelSvg locally for testing (it's not exported)
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

// Re-implement safeJsonParse for testing
async function safeJsonParse(res) {
  const text = await res.text();
  if (!text) {
    const err = new Error(`Empty response from Telegram (HTTP ${res.status})`);
    err.transient = true;
    err.errorCode = res.status === 429 ? 429 : 0;
    err.retryAfter = res.status === 429 ? 5 : undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`Invalid JSON from Telegram (HTTP ${res.status}): ${text.slice(0, 200)}`);
    err.transient = true;
    err.errorCode = res.status === 429 ? 429 : 0;
    err.retryAfter = res.status === 429 ? 5 : undefined;
    throw err;
  }
}

describe('buildLabelSvg', () => {
  it('generates valid SVG with price and quantity labels', () => {
    const svg = buildLabelSvg(800, 600, 150, 10);

    expect(svg).toContain('<svg');
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="600"');
    expect(svg).toContain('150 zł');
    expect(svg).toContain('10 шт');
    expect(svg).toContain('</svg>');
  });

  it('scales font size based on image height', () => {
    const svgSmall = buildLabelSvg(400, 300, 99, 5);
    const svgLarge = buildLabelSvg(800, 1200, 99, 5);

    // Font size is ~7% of height
    expect(svgSmall).toContain(`font-size="${Math.round(300 * 0.07)}px"`);
    expect(svgLarge).toContain(`font-size="${Math.round(1200 * 0.07)}px"`);
  });

  it('handles large price and quantity values', () => {
    const svg = buildLabelSvg(1000, 1000, 99999, 500);

    expect(svg).toContain('99999 zł');
    expect(svg).toContain('500 шт');
  });
});

describe('safeJsonParse', () => {
  function mockResponse(body, status = 200) {
    return {
      text: async () => body,
      status,
    };
  }

  it('parses valid JSON response', async () => {
    const data = await safeJsonParse(mockResponse('{"ok": true, "result": {"message_id": 1}}'));

    expect(data.ok).toBe(true);
    expect(data.result.message_id).toBe(1);
  });

  it('throws transient error on empty response', async () => {
    try {
      await safeJsonParse(mockResponse('', 400));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Empty response');
      expect(err.transient).toBe(true);
      expect(err.errorCode).toBe(0); // not 400 — empty is always transient
    }
  });

  it('throws transient error on invalid JSON', async () => {
    try {
      await safeJsonParse(mockResponse('<html>error</html>', 502));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Invalid JSON');
      expect(err.message).toContain('<html>error</html>');
      expect(err.transient).toBe(true);
    }
  });

  it('detects 429 status and sets retryAfter', async () => {
    try {
      await safeJsonParse(mockResponse('', 429));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.errorCode).toBe(429);
      expect(err.retryAfter).toBe(5);
      expect(err.transient).toBe(true);
    }
  });

  it('handles Telegram error JSON correctly', async () => {
    const errorBody = JSON.stringify({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });
    const data = await safeJsonParse(mockResponse(errorBody, 400));

    expect(data.ok).toBe(false);
    expect(data.error_code).toBe(400);
    expect(data.description).toContain('chat not found');
  });
});

describe('Sharp image processing', () => {
  it('creates a labeled image from a blank buffer', async () => {
    // Create a test image (100x100 red square)
    const inputBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    const meta = await sharp(inputBuffer).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);

    // Apply SVG label overlay
    const svg = buildLabelSvg(meta.width, meta.height, 150, 10);
    const result = await sharp(inputBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);

    // Verify output is still a valid JPEG
    const outputMeta = await sharp(result).metadata();
    expect(outputMeta.format).toBe('jpeg');
    expect(outputMeta.width).toBe(100);
    expect(outputMeta.height).toBe(100);
  });

  it('compresses image to lower quality', async () => {
    const inputBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 128, b: 255 } },
    }).jpeg({ quality: 100 }).toBuffer();

    const compressed = await sharp(inputBuffer)
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    // Compressed should be smaller or same size
    expect(compressed.length).toBeLessThanOrEqual(inputBuffer.length);
  });
});

describe('Broadcast service validation', () => {
  it('getPhotoUrl converts relative URL to absolute', () => {
    const SERVER_BASE_URL = 'http://localhost:5000';

    function getPhotoUrl(photoUrl) {
      if (!photoUrl) return null;
      if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) return photoUrl;
      return `${SERVER_BASE_URL.replace(/\/+$/, '')}/${photoUrl.replace(/^\/+/, '')}`;
    }

    expect(getPhotoUrl(null)).toBe(null);
    expect(getPhotoUrl('https://cdn.example.com/img.jpg')).toBe('https://cdn.example.com/img.jpg');
    expect(getPhotoUrl('/api/products/images/abc.jpg')).toBe('http://localhost:5000/api/products/images/abc.jpg');
    expect(getPhotoUrl('api/products/images/abc.jpg')).toBe('http://localhost:5000/api/products/images/abc.jpg');
  });

  it('getTelegramApiBase returns correct URL based on env', () => {
    function getTelegramApiBase() {
      const localApi = process.env.TELEGRAM_LOCAL_API_URL;
      if (localApi) return localApi;
      return 'https://api.telegram.org';
    }

    const original = process.env.TELEGRAM_LOCAL_API_URL;
    delete process.env.TELEGRAM_LOCAL_API_URL;

    expect(getTelegramApiBase()).toBe('https://api.telegram.org');

    process.env.TELEGRAM_LOCAL_API_URL = 'http://localhost:8081';
    expect(getTelegramApiBase()).toBe('http://localhost:8081');

    // Restore
    if (original) process.env.TELEGRAM_LOCAL_API_URL = original;
    else delete process.env.TELEGRAM_LOCAL_API_URL;
  });
});
