using System;

namespace LastEmber.UnityClient
{
    // 필드 이름은 서버 JSON과 같다(JsonUtility는 public 필드를 이름으로 대응시킨다).
    // 체크섬 같은 uint는 JsonUtility로 읽고 쓰지 않는다: 요청 본문은 RankedApi가 직접 만들어 정확한 값을 보낸다.

    /// <summary>POST /api/runs 의 201 응답: 서버가 발급한 랭킹 판.</summary>
    [Serializable]
    public sealed class IssuedRun
    {
        public string runId;
        /// <summary>구간 0의 시드. 서버가 HMAC에서 뽑은 부호 있는 32비트 정수다.</summary>
        public int seed;
        public int simVersion;
        public int segmentFrames;
    }

    public enum IssueKind
    {
        /// <summary>판을 받았다.</summary>
        Ok,
        /// <summary>서버는 응답했지만 한도(429) 또는 혼잡(503)으로 판을 주지 않았다.</summary>
        Quota,
        /// <summary>서버 미설정, 연결 실패, 시간 초과, 비 JSON 응답 등. 오프라인 판으로 진행한다.</summary>
        Offline,
    }

    public sealed class IssueOutcome
    {
        public IssueKind Kind;
        /// <summary>Kind == Ok 일 때만 값이 있다.</summary>
        public IssuedRun Run;
        /// <summary>Quota: 서버 오류 코드(quota_exceeded, ip_quota_exceeded, server_busy, rate_limited). Offline: 사유(offline, network, version_mismatch 등).</summary>
        public string Error;
        /// <summary>Quota일 때 서버가 알려 준 대기 시간. 모르면 0.</summary>
        public int RetryAfterMs;

        internal static IssueOutcome Offline(string error)
        {
            return new IssueOutcome { Kind = IssueKind.Offline, Error = error };
        }
    }

    [Serializable]
    public struct SegmentNext
    {
        public int index;
        public int seed;
    }

    /// <summary>구간 확정 결과. ok=false면 error에 서버 코드(expired, timeout, segment_conflict ...) 또는 network/offline.</summary>
    [Serializable]
    public sealed class SegmentReply
    {
        public bool ok;
        public int index;
        /// <summary>마지막 구간 확정이면 true. 이때 next는 비어 있다.</summary>
        public bool final;
        /// <summary>HasNext일 때만 유효하다. 다음 구간 번호와 그 시드.</summary>
        public SegmentNext next;
        public string error;

        public bool HasNext { get { return ok && !final; } }

        internal static SegmentReply Fail(string error)
        {
            return new SegmentReply { ok = false, error = error };
        }
    }

    /// <summary>최종 제출 결과. ok=false면 error에 서버 코드(mismatch, too_fast, server_busy ...) 또는 network/offline.</summary>
    [Serializable]
    public sealed class SubmitReply
    {
        public bool ok;
        public string name;
        public int score;
        public int kills;
        public bool won;
        public int rank;
        public string error;

        internal static SubmitReply Fail(string error)
        {
            return new SubmitReply { ok = false, error = error };
        }
    }

    [Serializable]
    public sealed class BoardEntry
    {
        public int rank;
        public string runId;
        public string name;
        public int score;
        public int kills;
        public int seconds;
        public int level;
        public bool won;
    }

    /// <summary>
    /// 검증된 판의 리플레이. simVersion 2는 구간 시드가 없고(segmentSeeds 빈 배열), 3은 구간 1, 2, ...의 시드가 들어 있다.
    /// inputs는 [code, count, ...] RLE 쌍이다.
    /// </summary>
    [Serializable]
    public sealed class ReplayData
    {
        public int seed;
        public int simVersion;
        public int[] segmentSeeds;
        public string name;
        public int score;
        public int[] inputs;
    }

    /// <summary>
    /// 최종 제출을 다시 부를 때 넘기는 상태. 마지막 구간을 서버가 받았다는 확인(ACK)을 기억해
    /// 재시도에서 구간을 다시 보내지 않게 한다. 같은 판의 같은 제출에는 같은 객체를 쓴다.
    /// </summary>
    public sealed class FinalSubmitState
    {
        public bool FinalCommitted;
    }

    /// <summary>서버·클라이언트가 쓰는 오류 코드와 재시도 가능 여부.</summary>
    public static class RankedErrors
    {
        public const string Network = "network";
        public const string Offline = "offline";
        public const string InvalidPayload = "invalid_payload";
        public const string NoSession = "no_session";
        public const string AlreadySubmitted = "already_submitted";
        public const string ServerBusy = "server_busy";
        public const string VerifyError = "verify_error";
        public const string RateLimited = "rate_limited";

        /// <summary>같은 제출을 사용자가 다시 시도해 볼 만한 오류(웹 ScoreSubmission과 같다).</summary>
        public static bool IsRetryable(string error)
        {
            return error == ServerBusy || error == VerifyError || error == RateLimited || error == Network;
        }
    }
}
