module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    maxWorkers: 1, // Run tests serially to avoid database conflicts
    collectCoverageFrom: [
        'services/**/*.ts',
        '!services/**/*.test.ts',
        '!services/**/*.spec.ts',
        '!services/**/index.ts',
        '!services/**/dist/**',
    ],
    coverageThreshold: {
        global: {
            branches: 40,
            functions: 45,
            lines: 45,
            statements: 45,
        },
    },
    moduleNameMapper: {
        '^@shared/(.*)$': '<rootDir>/services/shared/src/$1',
    },
};