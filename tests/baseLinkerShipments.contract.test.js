const {
  fetchBaseLinkerOrderPackages,
  fetchBaseLinkerPackageDetails,
  fetchBaseLinkerLabel,
} = require('../services/baseLinkerShipments');

describe('BaseLinker shipments read-only adapter', () => {
  it('loads all existing packages for one order with getOrderPackages', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      return {
        status: 'SUCCESS',
        packages: [{ package_id: 123, courier_code: 'inpost', courier_package_nr: 'TTN123' }],
      };
    };

    const result = await fetchBaseLinkerOrderPackages(49438989, callApi);
    expect(calls).toEqual([{ method: 'getOrderPackages', params: { order_id: 49438989 } }]);
    expect(result.packages[0].courier_package_nr).toBe('TTN123');
  });

  it('loads package details only through getPackageDetails', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      return { status: 'SUCCESS', package_details: [{ weight: 2.5, weight_unit: 'kg' }] };
    };

    const result = await fetchBaseLinkerPackageDetails(123, callApi);
    expect(calls).toEqual([{ method: 'getPackageDetails', params: { package_id: 123 } }]);
    expect(result.packageDetails).toHaveLength(1);
  });

  it('decodes getLabel base64 without any BaseLinker mutation call', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      return {
        status: 'SUCCESS',
        extension: 'pdf',
        label: Buffer.from('%PDF-read-only-label').toString('base64'),
      };
    };

    const result = await fetchBaseLinkerLabel({ packageId: 123, courierCode: 'inpost' }, callApi);
    expect(calls).toEqual([{ method: 'getLabel', params: { courier_code: 'inpost', package_id: 123 } }]);
    expect(result.contentType).toBe('application/pdf');
    expect(result.buffer.toString()).toBe('%PDF-read-only-label');
  });
});
