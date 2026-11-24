type SubmitResult = { ok: true; rank: number } | { ok: false; error: string };

type SubmissionStatus =
  | { state: 'pending'; retry: boolean }
  | { state: 'submitted'; rank: number }
  | { state: 'failed'; error: string; retry: boolean };

interface Attempt {
  send: () => Promise<SubmitResult>;
  pending: boolean;
}

// 결과 화면을 떠나면 늦게 돌아온 응답도 다음 판의 UI를 건드릴 수 없다.
export class ScoreSubmission {
  private current: Attempt | null = null;

  private readonly update: (status: SubmissionStatus) => void;

  constructor(update: (status: SubmissionStatus) => void) {
    this.update = update;
  }

  start(send: Attempt['send']): void {
    const attempt = { send, pending: false };
    this.current = attempt;
    void this.submit(attempt, false);
  }

  retry(): void {
    if (this.current && !this.current.pending) void this.submit(this.current, true);
  }

  discard(): void {
    this.current = null;
  }

  private async submit(attempt: Attempt, retry: boolean): Promise<void> {
    attempt.pending = true;
    this.update({ state: 'pending', retry });
    let result: SubmitResult;
    try {
      result = await attempt.send();
    } catch {
      result = { ok: false, error: 'network' };
    }
    if (this.current !== attempt) return;
    attempt.pending = false;
    if (result.ok) {
      this.discard();
      this.update({ state: 'submitted', rank: result.rank });
      return;
    }
    const error = result.error;
    const canRetry = error === 'server_busy' || error === 'verify_error' || error === 'rate_limited' || error === 'network';
    if (!canRetry) this.discard();
    this.update({ state: 'failed', error, retry: canRetry });
  }
}
