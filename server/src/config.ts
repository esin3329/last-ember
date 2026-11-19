export function parseShutdownTimeoutMs(value: string | undefined): number {
  const timeoutMs = value === undefined ? 10_000 : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be an integer between 100 and 600000');
  }
  return timeoutMs;
}
