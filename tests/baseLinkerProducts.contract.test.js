const {
  catalogKeyForOrderProduct,
  normalizeImageUrls,
  inventoryImageUrls,
  fetchBaseLinkerProductCatalog,
} = require('../services/baseLinkerProducts');

describe('BaseLinker product catalog enrichment', () => {
  it('namespaces a stable catalog key by our BaseLinker account UUID', () => {
    expect(catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }, 'A'))
      .toBe('A:shop:2445:524');
    expect(catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }, 'B'))
      .toBe('B:shop:2445:524');
    expect(() => catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }))
      .toThrow();
  });



  it('uses exact Allegro auction_id when getOrders has no product_id', () => {
    expect(catalogKeyForOrderProduct({
      storage: 'db',
      storage_id: '11049',
      auction_id: '18424860436',
    }, 'A', 'allegro')).toBe('A:offer:allegro:18424860436');
    expect(catalogKeyForOrderProduct({ auction_id: '18424860436' }, 'A', 'amazon')).toBeNull();
  });

  it('prefers default inventory gallery images and removes duplicates', () => {
    expect(normalizeImageUrls({
      2: 'https://cdn/two.jpg',
      1: 'https://cdn/one.jpg',
      '1|allegro_123': 'https://cdn/channel.jpg',
      3: 'https://cdn/one.jpg',
    })).toEqual(['https://cdn/one.jpg', 'https://cdn/two.jpg', 'https://cdn/channel.jpg']);
  });

  it('prefers exact channel media when that BaseLinker channel uses a separate gallery', () => {
    expect(inventoryImageUrls({
      images: {
        1: 'https://cdn/default.jpg',
        '1|allegro_12438': 'https://cdn/allegro.jpg',
      },
      media_options: { allegro_12438: 1 },
    }, { sourceType: 'allegro', sourceId: '12438' })).toEqual(['https://cdn/allegro.jpg']);
  });

  it('resolves an unlinked order line only inside its exact inventory by unique full name, then loads channel-aware media', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getInventoryProductsList') {
        expect(params).toEqual({ inventory_id: 11049, page: 1, filter_name: 'KREM DO STAWÓW HONDROSOL FORTE JOINT CARE OINTMENT 50ML' });
        return { status: 'SUCCESS', products: { 777: { id: 777, name: 'KREM DO STAWÓW HONDROSOL FORTE JOINT CARE OINTMENT 50ML', sku: '', ean: '' } } };
      }
      if (method === 'getInventoryProductsData') {
        expect(params.inventory_id).toBe(11049);
        expect(params.products).toEqual([777]);
        expect(params.include_channels_media).toBe(true);
        return {
          status: 'SUCCESS',
          products: {
            777: {
              images: { 1: 'https://cdn/default.jpg', '1|allegro_12438': 'https://cdn/allegro.jpg' },
              media_options: { allegro_12438: 1 },
            },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'A',
      order_source: 'allegro',
      order_source_id: '12438',
      products: [{
        storage: 'db', storage_id: '11049', product_id: '', auction_id: '18424860436',
        name: 'KREM DO STAWÓW HONDROSOL FORTE JOINT CARE OINTMENT 50ML', sku: '', ean: '',
      }],
    }], callApi);

    expect(calls.map((call) => call.method)).toEqual(['getInventoryProductsList', 'getInventoryProductsData']);
    expect(result.productCatalog['A:offer:allegro:18424860436']).toEqual({ state: 'resolved', images: ['https://cdn/allegro.jpg'] });
  });

  it('resolves a unique inventory name when BaseLinker stores the same words in another order', async () => {
    const calls = [];
    const orderName = 'KREM NA STAWY ARTHROVIA NANO-POWERED JOINT RELIEF CREAM 50ML';
    const inventoryName = 'ARTHROVIA KREM NA STAWY NANO-POWERED JOINT RELIEF CREAM 50ML';
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getInventoryProductsList' && params.filter_name === orderName) {
        return { status: 'SUCCESS', products: {} };
      }
      if (method === 'getInventoryProductsList' && params.filter_name === 'arthrovia') {
        return { status: 'SUCCESS', products: { 245743799: { id: 245743799, name: inventoryName } } };
      }
      if (method === 'getInventoryProductsData') {
        expect(params).toEqual({ inventory_id: 11049, products: [245743799], include_channels_media: true });
        return { status: 'SUCCESS', products: { 245743799: { images: { 1: 'https://cdn/arthrovia.jpg' } } } };
      }
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'A',
      order_source: 'allegro',
      products: [{
        storage: 'db', storage_id: '11049', product_id: '', auction_id: '18380197931',
        name: orderName, sku: '', ean: '',
      }],
    }], callApi);

    expect(calls.map((call) => call.method)).toEqual([
      'getInventoryProductsList',
      'getInventoryProductsList',
      'getInventoryProductsData',
    ]);
    expect(result.productCatalog['A:offer:allegro:18380197931'])
      .toEqual({ state: 'resolved', images: ['https://cdn/arthrovia.jpg'] });
  });

  it('resolves a large unlinked backlog with one documented inventory list scan and batched product data', async () => {
    const calls = [];
    const products = Array.from({ length: 12 }, (_, index) => ({
      storage: 'db',
      storage_id: 55,
      product_id: '',
      order_product_id: 1000 + index,
      auction_id: String(18000000000 + index),
      name: `Exact catalog product ${index}`,
      sku: `BULK-${index}`,
      ean: '',
    }));
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getInventoryProductsList') {
        expect(params).toEqual({ inventory_id: 55, page: 1, include_variants: true, filter_sort: 'id ASC' });
        return {
          products: Object.fromEntries(products.map((product, index) => [String(7000 + index), {
            id: 7000 + index,
            name: product.name,
            sku: product.sku,
            ean: '',
          }])),
        };
      }
      if (method === 'getInventoryProductsData') {
        expect(params.inventory_id).toBe(55);
        expect(params.products).toHaveLength(12);
        expect(params.include_channels_media).toBe(true);
        return {
          products: Object.fromEntries(params.products.map((id) => [String(id), {
            images: { 1: `https://cdn.example/${id}.jpg` },
          }])),
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'bulk-account',
      order_id: 9004,
      order_source: 'allegro',
      order_source_id: 12438,
      products,
    }], callApi);

    expect(calls.map((call) => call.method)).toEqual([
      'getInventoryProductsList',
      'getInventoryProductsData',
    ]);
    expect(result.productCatalogStats).toMatchObject({ requested: 12, resolved: 12, unresolved: 0 });
    expect(result.productCatalog['bulk-account:offer:allegro:18000000000'].images[0])
      .toBe('https://cdn.example/7000.jpg');
  });

  it('loads external shop product details/photos in one storage-aware lookup inside that account namespace', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getProductsData') {
        return {
          status: 'SUCCESS',
          products: {
            524: { product_id: 524, name: 'Product', images: ['https://cdn/product.jpg'] },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'A',
      order_id: 1,
      products: [{ storage: 'shop', storage_id: 2445, product_id: '524', order_product_id: 10 }],
    }], callApi);

    expect(calls).toEqual([{
      method: 'getProductsData',
      params: { storage_id: 'shop_2445', products: ['524'] },
    }]);
    expect(result.productCatalog['A:shop:2445:524'].images).toEqual(['https://cdn/product.jpg']);
    expect(result.productCatalogStats.resolved).toBe(1);
  });

  it('uses exact inventory product data for Base inventory lines', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getInventoryProductsData') {
        return {
          status: 'SUCCESS',
          products: {
            2685: { sku: 'EPL-432', images: { 1: 'https://cdn/base.jpg' }, variants: {} },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'inventory-source-account',
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], callApi);

    expect(calls[0].method).toBe('getInventoryProductsData');
    expect(calls[0].params.inventory_id).toBe(307);
    expect(calls[0].params.include_channels_media).toBe(true);
    expect(result.productCatalog['inventory-source-account:db:307:2685'].images).toEqual(['https://cdn/base.jpg']);
  });

  it('fails closed when an ordered Base product has no exact inventory id instead of scanning inventories heuristically', async () => {
    const callApi = vi.fn(async () => {
      throw new Error('upstream must not be called without exact storage_id');
    });

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'A',
      products: [{ storage: 'db', storage_id: 0, product_id: 2685 }],
    }], callApi);

    expect(callApi).not.toHaveBeenCalled();
    expect(result.productCatalog['A:db:0:2685']).toEqual({ state: 'unresolved_exact_source', images: [] });
  });

  it('keeps identical BaseLinker product ids from two accounts in separate cache keys', async () => {
    const calls = { A: 0, B: 0 };
    const makeCaller = (accountId) => async (method) => {
      calls[accountId] += 1;
      expect(method).toBe('getInventoryProductsData');
      return {
        status: 'SUCCESS',
        products: {
          2685: { images: { 1: `https://cdn/${accountId}.jpg` } },
        },
      };
    };

    const resultA = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'A',
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], makeCaller('A'));
    const resultB = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'B',
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], makeCaller('B'));

    expect(resultA.productCatalog['A:db:307:2685'].images).toEqual(['https://cdn/A.jpg']);
    expect(resultB.productCatalog['B:db:307:2685'].images).toEqual(['https://cdn/B.jpg']);
    expect(resultA.productCatalog['B:db:307:2685']).toBeUndefined();
    expect(resultB.productCatalog['A:db:307:2685']).toBeUndefined();
  });
});
