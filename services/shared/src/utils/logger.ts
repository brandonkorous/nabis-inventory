import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development';

const loggerConfig: any = {
     level: process.env.LOG_LEVEL || 'info',
     formatters: {
          level: (label: string) => ({ level: label }),
     },
     serializers: {
          err: pino.stdSerializers.err,
          req: pino.stdSerializers.req,
          res: pino.stdSerializers.res,
     },
     base: {
          service: process.env.SERVICE_NAME || 'nabis-inventory',
          environment: process.env.NODE_ENV || 'production',
     },
};

if (isDevelopment) {
     loggerConfig.transport = {
          target: 'pino-pretty',
          options: {
               colorize: true,
               translateTime: 'HH:MM:ss Z',
               ignore: 'pid,hostname',
          },
     };
}

export const logger = pino(loggerConfig);

export function createChildLogger(context: Record<string, any>) {
     return logger.child(context);
}
