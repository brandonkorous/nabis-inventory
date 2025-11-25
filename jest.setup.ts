// Jest setup file for test configuration
process.env.DATABASE_URL =
     process.env.DATABASE_URL ||
     'postgresql://nabis:nabis_dev_password@localhost:5432/nabis_inventory';
process.env.AMQP_URL = process.env.AMQP_URL || 'amqp://nabis:nabis_dev_password@localhost:5672';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Set test timeout
jest.setTimeout(10000);
