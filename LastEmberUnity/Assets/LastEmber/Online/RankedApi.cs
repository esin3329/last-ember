using System;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using LastEmber.Core;
using UnityEngine;
using UnityEngine.Networking;
using Debug = UnityEngine.Debug;

namespace LastEmber.UnityClient
{
    /// <summary>
    /// 기존 Node 랭킹 서버(server/src/app.ts)의 Unity 클라이언트. 웹 client/src/api.ts와 같은 프로토콜과 재시도 규칙을 쓴다.
    ///
    /// 규칙:
    ///  - 모든 호출은 메인 스레드에서 시작하고 await한다(UnityWebRequest 제약). 재개도 메인 스레드다.
    ///  - 서버 주소가 비었거나 잘못됐으면 IsConfigured == false이고, 네트워크 요청은 한 번도 나가지 않는다(오프라인).
    ///  - 실패는 예외가 아니라 결과 값(Offline/Quota/ok=false/null)이다. 예외는 취소(OperationCanceledException)뿐이다.
    ///  - 세션은 서버가 심는 HttpOnly 쿠키(ember_sid) 하나다. 발급 응답의 Set-Cookie에서 읽어 저장하고 이후 요청에 붙인다.
    ///  - 체크섬은 uint 그대로 십진수 문자열로 보낸다(JsonUtility를 거치지 않는다).
    /// </summary>
    public sealed class RankedApi
    {
        public const int SupportedSimVersion = Defs.SimVersion;
        const int LegacySimVersion = Defs.LegacySimVersion;

        // 웹 api.ts와 같은 시간 예산.
        const int IssueTimeoutMs = 2000;
        const int ReadTimeoutMs = 4000;
        const int SegmentAttemptMs = 3000;
        const int SubmitAttemptMs = 15000;
        /// <summary>구간 전송 한 번에 쓸 수 있는 전체 시간(재시도 포함). 지나면 서버 없이 로컬로 이어간다.</summary>
        public const int SegmentDeadlineMs = 6000;
        /// <summary>마지막 구간 확정에 쓸 수 있는 전체 시간.</summary>
        public const int FinalSegmentDeadlineMs = 15000;
        const int SubmitPollMs = 12000;
        const int SubmitPollIntervalMs = 1000;

        static readonly Regex RunIdPattern = new Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.CultureInvariant);

        readonly string baseUrl;
        readonly bool https;
        readonly IRankedSessionStore store;
        RankedSession session;

        /// <param name="baseUrl">서버 기준 주소(예: https://ember.example.com). 비었거나 http(s) 절대 주소가 아니면 오프라인.</param>
        /// <param name="allowInsecureHttp">
        /// Android 릴리스 빌드에서 http://를 허용할지. 기본은 거부(HTTPS만). 에디터·개발 빌드·Android 외 플랫폼은 http도 허용한다.
        /// Unity의 Insecure HTTP 플레이어 설정도 http 요청을 따로 막을 수 있다.
        /// </param>
        /// <param name="sessionStore">세션 보관소. null이면 PlayerPrefs.</param>
        public RankedApi(string baseUrl, bool allowInsecureHttp = false, IRankedSessionStore sessionStore = null)
        {
            store = sessionStore ?? new PlayerPrefsSessionStore();
            this.baseUrl = Normalize(baseUrl, allowInsecureHttp, out https);
            if (this.baseUrl != null) LoadSession();
        }

        public bool IsConfigured { get { return baseUrl != null; } }

        /// <summary>정규화한 서버 주소(끝 슬래시 없음). 미설정이면 null.</summary>
        public string BaseUrl { get { return baseUrl; } }

        public bool HasSession { get { return CurrentSessionToken() != null; } }

        /// <summary>저장된 세션을 버린다(서버를 바꾸거나 계정 초기화 때). 다음 판 발급에서 서버가 새 세션을 준다.</summary>
        public void ClearSession()
        {
            session = null;
            if (baseUrl != null) store.Clear(baseUrl);
        }

        // ---- 공개 호출 ----

        /// <summary>새 랭킹 판을 발급받는다. 서버 없음/연결 실패는 Offline, 한도·혼잡은 Quota.</summary>
        public async Task<IssueOutcome> IssueAsync(CancellationToken ct)
        {
            if (baseUrl == null) return IssueOutcome.Offline(RankedErrors.Offline);
            HttpReply r = await SendAsync("POST", "/api/runs", "{}", IssueTimeoutMs, true, true, ct);
            if (r == null) return IssueOutcome.Offline(RankedErrors.Network);
            if (r.Status == 201)
            {
                IssuedRun run = FromJson<IssuedRun>(r.Body);
                if (run == null || !IsRunId(run.runId) || run.segmentFrames <= 0) return IssueOutcome.Offline("invalid_response");
                if (run.simVersion != SupportedSimVersion) return IssueOutcome.Offline("version_mismatch");
                return new IssueOutcome { Kind = IssueKind.Ok, Run = run };
            }
            if (r.Status == 429 || r.Status == 503)
            {
                ErrorBody e = ReadError(r);
                return new IssueOutcome { Kind = IssueKind.Quota, Error = e.error ?? "unknown", RetryAfterMs = e.retryAfterMs };
            }
            return IssueOutcome.Offline("http_" + r.Status.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 구간 입력(RLE [code, count, ...])을 확정하고 다음 구간 시드를 받는다.
        /// 같은 입력의 재전송은 서버가 같은 응답을 주므로, 네트워크 오류·시간 초과·5xx·425(too_early)만 deadlineMs 안에서 다시 보낸다.
        /// 그 밖의 오류(만료, 충돌 등)는 같은 결과이므로 바로 돌려준다.
        /// </summary>
        public async Task<SegmentReply> CommitAsync(string id, int index, int[] runs, bool final, CancellationToken ct, int deadlineMs = SegmentDeadlineMs)
        {
            if (baseUrl == null) return SegmentReply.Fail(RankedErrors.Offline);
            if (!IsRunId(id) || index < 0 || index > 999 || !IsValidRuns(runs)) return SegmentReply.Fail(RankedErrors.InvalidPayload);

            string path = "/api/runs/" + id + "/segments/" + index.ToString(CultureInfo.InvariantCulture);
            string body = BuildCommitBody(runs, final);
            Stopwatch clock = Stopwatch.StartNew();
            string lastError = RankedErrors.Network;
            for (;;)
            {
                long remaining = deadlineMs - clock.ElapsedMilliseconds;
                if (remaining <= 0) return SegmentReply.Fail(lastError);
                HttpReply r = await SendAsync("POST", path, body, (int)Math.Min(SegmentAttemptMs, remaining), true, false, ct);
                int waitMs = 300;
                if (r != null && r.Status == 200)
                {
                    SegmentReply reply = FromJson<SegmentReply>(r.Body);
                    if (reply != null)
                    {
                        reply.ok = true;
                        reply.error = null;
                        return reply;
                    }
                    lastError = RankedErrors.Network;
                }
                else if (r != null && r.Status < 500 && r.Status != 425)
                {
                    return SegmentReply.Fail(ReadError(r).error ?? "unknown");
                }
                else if (r != null)
                {
                    ErrorBody e = ReadError(r);
                    lastError = e.error ?? RankedErrors.ServerBusy;
                    if (r.Status == 425) waitMs = Math.Min(e.retryAfterMs > 0 ? e.retryAfterMs : 500, 2000);
                }
                else
                {
                    lastError = RankedErrors.Network;
                }
                if (deadlineMs - clock.ElapsedMilliseconds <= waitMs) return SegmentReply.Fail(lastError);
                await Task.Delay(waitMs, ct);
            }
        }

        /// <summary>
        /// 점수·체크섬만 제출한다(마지막 구간은 이미 확정된 상태). 서버는 저장한 구간 입력으로만 검증한다.
        /// 다른 요청이 검증 중이라 already_submitted가 오면 간격을 두고 같은 제출을 다시 보내 결과를 회수한다.
        /// 이미 검증된 같은 점수·체크섬의 재제출은 서버가 같은 성공 응답을 준다.
        /// </summary>
        public async Task<SubmitReply> SubmitAsync(string id, string name, int score, uint checksum, CancellationToken ct)
        {
            if (baseUrl == null) return SubmitReply.Fail(RankedErrors.Offline);
            if (!IsRunId(id)) return SubmitReply.Fail(RankedErrors.InvalidPayload);

            string path = "/api/runs/" + id + "/submit";
            string body = BuildSubmitBody(name, score, checksum);
            Stopwatch clock = Stopwatch.StartNew();
            for (;;)
            {
                HttpReply r = await SendAsync("POST", path, body, SubmitAttemptMs, true, false, ct);
                if (r == null) return SubmitReply.Fail(RankedErrors.Network);
                if (r.Status == 200)
                {
                    SubmitReply reply = FromJson<SubmitReply>(r.Body);
                    if (reply == null) return SubmitReply.Fail(RankedErrors.Network);
                    reply.ok = true;
                    reply.error = null;
                    return reply;
                }
                string error = ReadError(r).error ?? "unknown";
                if (error != RankedErrors.AlreadySubmitted || SubmitPollMs - clock.ElapsedMilliseconds <= SubmitPollIntervalMs)
                {
                    return SubmitReply.Fail(error);
                }
                await Task.Delay(SubmitPollIntervalMs, ct);
            }
        }

        /// <summary>
        /// 판 끝: 마지막 구간을 확정한 뒤 점수·체크섬을 제출한다. 같은 state와 인자로 다시 불러도 안전하다.
        ///  - 마지막 구간 ACK를 받았으면 이후 재시도에서 구간을 다시 보내지 않는다.
        ///  - ACK가 유실돼 구간을 다시 보냈는데 already_submitted면 구간은 이미 받은 것이므로 제출로 넘어간다.
        /// </summary>
        public async Task<SubmitReply> SubmitFinalAsync(
            string id, int finalIndex, int[] finalRuns, string name, int score, uint checksum, FinalSubmitState state, CancellationToken ct)
        {
            if (state == null) state = new FinalSubmitState();
            if (!state.FinalCommitted)
            {
                SegmentReply committed = await CommitAsync(id, finalIndex, finalRuns, true, ct, FinalSegmentDeadlineMs);
                if (!committed.ok && committed.error != RankedErrors.AlreadySubmitted) return SubmitReply.Fail(committed.error);
                state.FinalCommitted = true;
            }
            return await SubmitAsync(id, name, score, checksum, ct);
        }

        /// <summary>상위 기록. 서버 없음/실패는 null.</summary>
        public async Task<BoardEntry[]> BoardAsync(CancellationToken ct, int limit = 10)
        {
            if (baseUrl == null) return null;
            int n = Math.Max(1, Math.Min(50, limit));
            HttpReply r = await SendAsync("GET", "/api/leaderboard?limit=" + n.ToString(CultureInfo.InvariantCulture), null, ReadTimeoutMs, false, false, ct);
            if (r == null || r.Status != 200) return null;
            BoardReply board = FromJson<BoardReply>(r.Body);
            return board == null ? null : board.entries;
        }

        /// <summary>검증된 판의 리플레이(v2 또는 v3). 없음/실패/형식 불량은 null.</summary>
        public async Task<ReplayData> ReplayAsync(string id, CancellationToken ct)
        {
            if (baseUrl == null || !IsRunId(id)) return null;
            HttpReply r = await SendAsync("GET", "/api/runs/" + id + "/replay", null, ReadTimeoutMs, false, false, ct);
            if (r == null || r.Status != 200) return null;
            ReplayData replay = FromJson<ReplayData>(r.Body);
            if (replay == null) return null;
            if (replay.simVersion != LegacySimVersion && replay.simVersion != SupportedSimVersion) return null;
            if (replay.inputs == null || replay.inputs.Length % 2 != 0) return null;
            if (replay.segmentSeeds == null) replay.segmentSeeds = new int[0];
            return replay;
        }

        // ---- HTTP ----

        internal sealed class HttpReply
        {
            public int Status;
            public string Body;
        }

        [Serializable]
        internal class ErrorBody
        {
            public string error;
            public int retryAfterMs;
        }

        [Serializable]
        internal class BoardReply
        {
            public BoardEntry[] entries;
        }

        /// <summary>
        /// 응답을 받으면 HttpReply, 연결 실패·시간 초과·비 JSON 응답이면 null(웹 api.ts의 call과 같다).
        /// 취소되면 OperationCanceledException.
        /// </summary>
        async Task<HttpReply> SendAsync(string method, string path, string json, int timeoutMs, bool withSession, bool captureCookie, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            if (timeoutMs <= 0) return null;

            using (var request = new UnityWebRequest(baseUrl + path, method))
            {
                request.downloadHandler = new DownloadHandlerBuffer();
                // 리다이렉트를 따라가면 쿠키가 다른 호스트로 새거나 HTTPS에서 HTTP로 내려갈 수 있다. 이 서버는 리다이렉트하지 않는다.
                request.redirectLimit = 0;
                request.SetRequestHeader("Accept", "application/json");
                if (json != null)
                {
                    request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
                    request.SetRequestHeader("Content-Type", "application/json");
                }
                if (withSession)
                {
                    string token = CurrentSessionToken();
                    if (token != null) request.SetRequestHeader("Cookie", RankedSessionCookie.Name + "=" + token);
                }

                Stopwatch clock = Stopwatch.StartNew();
                UnityWebRequestAsyncOperation op;
                try { op = request.SendWebRequest(); }
                catch (InvalidOperationException e)
                {
                    Debug.LogWarning($"Ranked request could not start: {e.Message}");
                    return null;
                }
                bool aborted = false;
                // Abort는 메인 스레드에서만 부를 수 있으므로 타이머·토큰 콜백이 아니라 프레임마다 확인한다.
                while (!op.isDone)
                {
                    if (!aborted && (ct.IsCancellationRequested || clock.ElapsedMilliseconds >= timeoutMs))
                    {
                        request.Abort();
                        aborted = true;
                    }
                    await Task.Yield();
                }
                ct.ThrowIfCancellationRequested();
                if (aborted) return null;

                UnityWebRequest.Result result = request.result;
                if (result == UnityWebRequest.Result.ConnectionError || result == UnityWebRequest.Result.DataProcessingError) return null;
                long status = request.responseCode;
                if (status <= 0) return null;
                string contentType = request.GetResponseHeader("Content-Type");
                if (contentType == null || contentType.IndexOf("application/json", StringComparison.OrdinalIgnoreCase) < 0) return null;

                if (captureCookie && status == 201) CaptureSession(request.GetResponseHeader("Set-Cookie"));
                return new HttpReply { Status = (int)status, Body = request.downloadHandler.text };
            }
        }

        /// <summary>오류 본문을 읽는다. 서버가 세션을 모른다고 하면(no_session) 저장된 세션을 버려 다음 발급에서 새로 받게 한다.</summary>
        ErrorBody ReadError(HttpReply r)
        {
            ErrorBody e = FromJson<ErrorBody>(r.Body) ?? new ErrorBody();
            if (e.error == RankedErrors.NoSession) ClearSession();
            return e;
        }

        static T FromJson<T>(string json) where T : class
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                return JsonUtility.FromJson<T>(json);
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        // ---- 세션 ----

        static long NowUnix()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        }

        void LoadSession()
        {
            RankedSession stored = store.Load(baseUrl);
            if (stored == null) return;
            if (stored.ExpiresAtUnix <= NowUnix()) store.Clear(baseUrl);
            else session = stored;
        }

        /// <summary>지금 보낼 수 있는 세션 토큰. 만료됐거나 Secure 쿠키인데 HTTPS가 아니면 null.</summary>
        string CurrentSessionToken()
        {
            RankedSession s = session;
            if (s == null) return null;
            if (s.ExpiresAtUnix <= NowUnix()) return null;
            if (s.Secure && !https) return null;
            return s.Token;
        }

        void CaptureSession(string setCookie)
        {
            RankedSession fresh = RankedSessionCookie.Parse(setCookie, NowUnix());
            if (fresh == null) return;
            session = fresh;
            store.Save(baseUrl, fresh);
        }

        // ---- 입력 검증·본문 ----

        static bool IsRunId(string id)
        {
            return id != null && RunIdPattern.IsMatch(id);
        }

        /// <summary>RLE 쌍의 형식(shared/input.ts의 isValidCode·countTicks와 같은 규칙). 프레임 수 한도는 서버가 판정한다.</summary>
        static bool IsValidRuns(int[] runs)
        {
            if (runs == null || runs.Length == 0 || runs.Length % 2 != 0) return false;
            for (int i = 0; i < runs.Length; i += 2)
            {
                int code = runs[i];
                if (code < 0 || code >= 128 || (code & 15) > 8) return false;
                if (runs[i + 1] < 1) return false;
            }
            return true;
        }

        static string BuildCommitBody(int[] runs, bool final)
        {
            var sb = new StringBuilder(32 + runs.Length * 4);
            sb.Append("{\"inputs\":[");
            for (int i = 0; i < runs.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(runs[i].ToString(CultureInfo.InvariantCulture));
            }
            sb.Append("],\"final\":").Append(final ? "true" : "false").Append('}');
            return sb.ToString();
        }

        static string BuildSubmitBody(string name, int score, uint checksum)
        {
            var sb = new StringBuilder(96);
            sb.Append("{\"name\":");
            AppendJsonString(sb, name ?? "");
            // uint는 부호 없는 십진수로 그대로 쓴다. 서버는 부호 없는 32비트 값(h >>> 0)과 비교한다.
            sb.Append(",\"score\":").Append(score.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"checksum\":").Append(checksum.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            return sb.ToString();
        }

        /// <summary>이름은 서버가 12자로 다시 정리한다. 요청 본문 한도(4KB)를 지키려고 여기서도 64 UTF-16 단위로 자른다.</summary>
        const int MaxNameUnits = 64;

        static void AppendJsonString(StringBuilder sb, string s)
        {
            int len = Math.Min(s.Length, MaxNameUnits);
            if (len < s.Length && len > 0 && char.IsHighSurrogate(s[len - 1])) len--;
            sb.Append('"');
            for (int i = 0; i < len; i++)
            {
                char c = s[i];
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else if (char.IsHighSurrogate(c) && i + 1 < len && char.IsLowSurrogate(s[i + 1]))
                {
                    sb.Append(c).Append(s[i + 1]);
                    i++;
                }
                else if (char.IsSurrogate(c)) sb.Append("\\ufffd");
                else sb.Append(c);
            }
            sb.Append('"');
        }

        // ---- 주소 ----

        /// <summary>http(s) 절대 주소만 받는다. 사용자 정보·쿼리·조각이 있으면 버린다. 허용되지 않으면 null.</summary>
        static string Normalize(string raw, bool allowInsecureHttp, out bool isHttps)
        {
            isHttps = false;
            if (string.IsNullOrWhiteSpace(raw)) return null;
            Uri uri;
            if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out uri)) return null;
            if (!string.IsNullOrEmpty(uri.UserInfo)) return null;
            if (uri.Scheme == Uri.UriSchemeHttps) isHttps = true;
            else if (uri.Scheme == Uri.UriSchemeHttp)
            {
                bool allowed = allowInsecureHttp || Application.isEditor || Debug.isDebugBuild || Application.platform != RuntimePlatform.Android;
                if (!allowed) return null;
            }
            else return null;
            return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        }
    }
}
