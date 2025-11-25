import { pool, checkConnection, withTransaction } from '@nabis/shared/src/db/client';
import type { PoolClient } from 'pg';

describe('Database Client', () => {
     describe('checkConnection', () => {
          it('should return true when database is accessible', async () => {
               const result = await checkConnection();
               expect(result).toBe(true);
          });

          it('should return false when database query fails', async () => {
               const mockConnect = jest
                    .spyOn(pool, 'connect')
                    .mockRejectedValueOnce(new Error('Connection failed') as never);

               const result = await checkConnection();
               expect(result).toBe(false);

               mockConnect.mockRestore();
          });
     });

     describe('withTransaction', () => {
          it('should execute function within a transaction and commit', async () => {
               const mockFn = jest.fn().mockResolvedValue('success');

               const result = await withTransaction(mockFn);

               expect(result).toBe('success');
               expect(mockFn).toHaveBeenCalledTimes(1);
               expect(mockFn).toHaveBeenCalledWith(
                    expect.objectContaining({
                         query: expect.any(Function),
                    })
               );
          });

          it('should rollback transaction on error', async () => {
               const error = new Error('Transaction failed');
               const mockFn = jest.fn().mockRejectedValue(error);

               await expect(withTransaction(mockFn)).rejects.toThrow('Transaction failed');
               expect(mockFn).toHaveBeenCalledTimes(1);
          });

          it('should pass client to callback function', async () => {
               let capturedClient: PoolClient | undefined;
               await withTransaction(async (client) => {
                    capturedClient = client;
                    expect(client.query).toBeDefined();
                    return 'done';
               });

               expect(capturedClient).toBeDefined();
          });

          it('should release client even if transaction fails', async () => {
               const mockFn = jest.fn().mockRejectedValue(new Error('Fail'));

               try {
                    await withTransaction(mockFn);
               } catch (error) {
                    // Expected to throw
               }

               // If we can still query the pool, the client was released
               const client = await pool.connect();
               expect(client).toBeDefined();
               client.release();
          });
     });

     describe('pool configuration', () => {
          it('should have pool configured', () => {
               expect(pool).toBeDefined();
          });

          it('should be able to acquire and release connections', async () => {
               const client = await pool.connect();
               expect(client).toBeDefined();
               expect(client.query).toBeDefined();

               const result = await client.query('SELECT 1 as value');
               expect(result.rows[0].value).toBe(1);

               client.release();
          });
     });
});
