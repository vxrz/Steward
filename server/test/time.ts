/**
 * A time limit for a test, stretched while coverage is measured (vitest.config.ts sets SM_TEST_TIME_FACTOR): the
 * instrumented code runs several times slower, the limit still catches a runaway.
 */
export const timeLimit = (ms: number): number => ms * (Number(process.env.SM_TEST_TIME_FACTOR) || 1);
