/**
 * A time limit for a test, stretched by SM_TEST_TIME_FACTOR (vitest.config.ts): coverage measurement makes the code
 * run several times slower, and the test files running in parallel share the CPUs. A limit in a test says "linear,
 * not quadratic" or "answers at once": it still catches a runaway, but not a loaded machine.
 */
export const timeLimit = (ms: number): number => ms * (Number(process.env.SM_TEST_TIME_FACTOR) || 1);
