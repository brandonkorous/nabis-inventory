import { logger } from '@nabis/shared/src/utils/logger';

describe('Logger', () => {
     it('should be defined', () => {
          expect(logger).toBeDefined();
     });

     it('should have standard logging methods', () => {
          expect(logger.info).toBeDefined();
          expect(logger.error).toBeDefined();
          expect(logger.warn).toBeDefined();
          expect(logger.debug).toBeDefined();
     });

     it('should log info messages', () => {
          const spy = jest.spyOn(logger, 'info');
          logger.info('Test info message');
          expect(spy).toHaveBeenCalled();
          spy.mockRestore();
     });

     it('should log error messages', () => {
          const spy = jest.spyOn(logger, 'error');
          logger.error('Test error message');
          expect(spy).toHaveBeenCalled();
          spy.mockRestore();
     });

     it('should log warn messages', () => {
          const spy = jest.spyOn(logger, 'warn');
          logger.warn('Test warn message');
          expect(spy).toHaveBeenCalled();
          spy.mockRestore();
     });

     it('should log debug messages', () => {
          const spy = jest.spyOn(logger, 'debug');
          logger.debug('Test debug message');
          expect(spy).toHaveBeenCalled();
          spy.mockRestore();
     });

     it('should handle structured logging with objects', () => {
          const spy = jest.spyOn(logger, 'info');
          logger.info({ userId: 123, action: 'test' }, 'User action');
          expect(spy).toHaveBeenCalled();
          spy.mockRestore();
     });

     it('should handle error objects', () => {
          const spy = jest.spyOn(logger, 'error');
          const error = new Error('Test error');
          logger.error({ err: error }, 'An error occurred');
          expect(spy).toHaveBeenCalled();
          spy.mockRestore();
     });
});
