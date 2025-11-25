import { createWmsClient, WmsHttpClient } from '@nabis/shared/src/clients/wms-client';

describe('WMS HTTP Client', () => {
     beforeEach(() => {
          process.env.WMS_API_URL = 'https://test-wms-api.example.com';
          process.env.WMS_API_KEY = 'test-api-key';
     });

     afterEach(() => {
          delete process.env.WMS_API_URL;
          delete process.env.WMS_API_KEY;
          delete process.env.WMS_CLIENT_TYPE;
     });

     describe('createWmsClient factory', () => {
          it('should create mock client by default', () => {
               delete process.env.WMS_CLIENT_TYPE;
               const client = createWmsClient();
               expect(client).toBeDefined();
          });

          it('should create mock client when WMS_CLIENT_TYPE is mock', () => {
               process.env.WMS_CLIENT_TYPE = 'mock';
               const client = createWmsClient();
               expect(client).toBeDefined();
          });

          it('should create HTTP client when WMS_CLIENT_TYPE is http', () => {
               process.env.WMS_CLIENT_TYPE = 'http';
               process.env.WMS_API_URL = 'https://test.example.com';
               process.env.WMS_API_KEY = 'test-key';

               const client = createWmsClient();
               expect(client).toBeDefined();
               expect(client).toBeInstanceOf(WmsHttpClient);
          });

          it('should throw error when HTTP client missing URL', () => {
               process.env.WMS_CLIENT_TYPE = 'http';
               delete process.env.WMS_API_URL;
               process.env.WMS_API_KEY = 'test-key';

               expect(() => createWmsClient()).toThrow(
                    'WMS_API_URL and WMS_API_KEY must be set for HTTP client'
               );
          });

          it('should throw error when HTTP client missing API key', () => {
               process.env.WMS_CLIENT_TYPE = 'http';
               process.env.WMS_API_URL = 'https://test.example.com';
               delete process.env.WMS_API_KEY;

               expect(() => createWmsClient()).toThrow(
                    'WMS_API_URL and WMS_API_KEY must be set for HTTP client'
               );
          });
     });

     describe('WmsHttpClient instantiation', () => {
          it('should create HTTP client with baseUrl and apiKey', () => {
               const client = new WmsHttpClient('https://test.example.com', 'test-key');
               expect(client).toBeDefined();
               expect(client).toBeInstanceOf(WmsHttpClient);
          });

          it('should handle client configuration', () => {
               const client = new WmsHttpClient('https://test.example.com', 'test-key');
               expect(client).toBeDefined();
          });
     });
});
