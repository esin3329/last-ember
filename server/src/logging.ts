export type AppLogEvent =
  | { event: 'run_verified'; runId: string; score: number; ticks: number }
  | { event: 'run_rejected'; runId: string; reason: string }
  | { event: 'verification_unavailable'; runId: string; reason: 'server_busy' | 'verify_error' }
  | { event: 'request_error'; message: string };

type ServerLogEvent = AppLogEvent
  | { event: 'server_started'; host?: string; port: number; workers: number; servingClient: boolean; message: string }
  | { event: 'verifier_fatal'; message: string }
  | { event: 'shutdown_timeout'; timeoutMs: number; message: string };

export function writeLog(event: ServerLogEvent, level: 'info' | 'error' = 'info'): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, ...event });
  if (level === 'error') console.error(line);
  else console.log(line);
}
