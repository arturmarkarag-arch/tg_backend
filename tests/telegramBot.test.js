const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getShippingBlockPositions } = require('../telegramBot');
const Product = require('../models/Product');
const Block = require('../models/Block');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
});

afterEach(async () => {
  await Product.deleteMany({});
  await Block.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Telegram shipping block ordering', () => {
  it('returns block positions for products and preserves block order', async () => {
    const productA = await Product.create({ brand: 'Product A', price: 10, quantity: 1 });
    const productB = await Product.create({ brand: 'Product B', price: 15, quantity: 1 });
    const productC = await Product.create({ brand: 'Product C', price: 20, quantity: 1 });

    await Block.create({ blockId: 7, productIds: [productB._id] });
    await Block.create({ blockId: 15, productIds: [productC._id] });
    await Block.create({ blockId: 1, productIds: [productA._id] });

    const positions = await getShippingBlockPositions([
      productA._id.toString(),
      productB._id.toString(),
      productC._id.toString(),
    ]);

    expect(positions.get(String(productA._id))).toEqual({ blockId: 1, index: 0 });
    expect(positions.get(String(productB._id))).toEqual({ blockId: 7, index: 0 });
    expect(positions.get(String(productC._id))).toEqual({ blockId: 15, index: 0 });
  });

  it('returns undefined for products that are not assigned to any block', async () => {
    const product = await Product.create({ brand: 'Unassigned product', price: 5, quantity: 1 });
    const positions = await getShippingBlockPositions([product._id.toString()]);
    expect(positions.get(String(product._id))).toBeUndefined();
  });
});
