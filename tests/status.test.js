process.env.OPENAI_API_KEY = '';
process.env.R2_BUCKET_NAME = 'test-bucket';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_ENDPOINT = 'https://example.com';
process.env.R2_REGION = 'auto';

const request = require('supertest');
const app = require('../app');

describe('Status API', () => {
  it('returns bot status from /api/bot-status', async () => {
    const res = await request(app).get('/api/bot-status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('active');
    expect(res.body).toHaveProperty('mode');
    expect(res.body).toHaveProperty('hasToken');
  });

  it('returns OpenAI status error when API key is missing', async () => {
    const res = await request(app).get('/api/openai-status');

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('status', 'error');
    expect(res.body).toHaveProperty('message');
    expect(res.body.message).toMatch(/OPENAI_API_KEY|not configured/i);
  });
});
