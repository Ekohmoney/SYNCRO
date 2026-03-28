import { FiatRateProvider } from '../src/services/exchange-rate/fiat-provider';

// Mock logger
jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('FiatRateProvider', () => {
  const provider = new FiatRateProvider();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns rates from ExchangeRate-API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base: 'USD',
        rates: { EUR: 0.92, GBP: 0.79, NGN: 1520 },
      }),
    });

    const rates = await provider.getRates('USD');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.exchangerate-api.com/v4/latest/USD'
    );
    expect(rates.EUR).toBe(0.92);
    expect(rates.NGN).toBe(1520);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(provider.getRates('USD')).rejects.toThrow('Fiat rate API returned status 500');
  });

  it('supports fiat currencies', () => {
    expect(provider.supportsCurrency('USD')).toBe(true);
    expect(provider.supportsCurrency('NGN')).toBe(true);
    expect(provider.supportsCurrency('XLM')).toBe(false);
  });
});
