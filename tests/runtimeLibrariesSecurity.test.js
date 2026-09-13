'use strict';

const http = require('node:http');
const axios = require('axios');
const sharp = require('sharp');
const { buildImageVariants, MAIN_MAX, THUMB_MAX } = require('../utils/imageService');

const HTTP_IMAGE_BODY = Buffer.from('local-image-fixture');

describe('runtime library security regressions', () => {
  let server;
  let baseUrl;
  let requestedPaths;

  beforeAll(async () => {
    requestedPaths = [];
    server = http.createServer((req, res) => {
      requestedPaths.push(req.url);
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/image' });
        res.end();
        return;
      }
      if (req.url === '/large') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(1024, 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(HTTP_IMAGE_BODY);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('keeps redirects disabled for guarded Axios image requests', async () => {
    requestedPaths.length = 0;
    const response = await axios.get(`${baseUrl}/redirect`, {
      maxRedirects: 0,
      validateStatus: () => true,
    });

    expect(response.status).toBe(302);
    expect(requestedPaths).toEqual(['/redirect']);
  });

  it('keeps Axios response-size enforcement active', async () => {
    await expect(axios.get(`${baseUrl}/large`, {
      responseType: 'arraybuffer',
      maxContentLength: 128,
    })).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  });

  it('builds bounded JPEG variants with the upgraded Sharp runtime', async () => {
    const input = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 20, g: 120, b: 220 },
      },
    }).png().toBuffer();
    const result = await buildImageVariants(input);
    const [main, thumb] = await Promise.all([
      sharp(result.main).metadata(),
      sharp(result.thumb).metadata(),
    ]);

    expect(result.filename).toMatch(/^[0-9a-f-]+\.jpg$/i);
    expect(main.format).toBe('jpeg');
    expect(thumb.format).toBe('jpeg');
    expect(main.width).toBeLessThanOrEqual(MAIN_MAX);
    expect(main.height).toBeLessThanOrEqual(MAIN_MAX);
    expect(thumb.width).toBeLessThanOrEqual(THUMB_MAX);
    expect(thumb.height).toBeLessThanOrEqual(THUMB_MAX);
  });
});
