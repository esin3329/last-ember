using System;
using System.Globalization;
using System.Text.RegularExpressions;
using UnityEngine;

namespace LastEmber.UnityClient
{
    /// <summary>서버가 심어 주는 세션 쿠키(ember_sid)의 값. 서버 쪽에서는 HttpOnly 쿠키 하나가 세션의 전부다.</summary>
    public sealed class RankedSession
    {
        public string Token;
        /// <summary>UTC Unix 초. 이 시각 이후에는 쿠키를 보내지 않는다.</summary>
        public long ExpiresAtUnix;
        /// <summary>서버가 Secure로 심은 쿠키는 HTTPS 연결에만 보낸다.</summary>
        public bool Secure;
    }

    /// <summary>세션을 앱 재시작 너머로 보관하는 곳. 기본 구현은 PlayerPrefs(Android에서는 앱 전용 SharedPreferences)다.</summary>
    public interface IRankedSessionStore
    {
        /// <summary>origin(서버 기준 주소)에 저장된 세션. 없으면 null.</summary>
        RankedSession Load(string origin);
        void Save(string origin, RankedSession session);
        void Clear(string origin);
    }

    public sealed class PlayerPrefsSessionStore : IRankedSessionStore
    {
        const string Key = "LastEmber.Ranked.Session.v1";

        public RankedSession Load(string origin)
        {
            string raw = PlayerPrefs.GetString(Key, "");
            if (raw.Length == 0) return null;
            string[] parts = raw.Split('\n');
            if (parts.Length != 4 || parts[0] != origin) return null;
            long expires;
            if (!RankedSessionCookie.IsValidToken(parts[1])) return null;
            if (!long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out expires)) return null;
            return new RankedSession { Token = parts[1], ExpiresAtUnix = expires, Secure = parts[3] == "1" };
        }

        public void Save(string origin, RankedSession session)
        {
            string raw = origin + "\n" + session.Token + "\n" + session.ExpiresAtUnix.ToString(CultureInfo.InvariantCulture) + "\n" + (session.Secure ? "1" : "0");
            PlayerPrefs.SetString(Key, raw);
            PlayerPrefs.Save();
        }

        public void Clear(string origin)
        {
            // 저장은 한 칸이다. 다른 서버의 세션은 지우지 않는다.
            if (PlayerPrefs.GetString(Key, "").Split('\n')[0] != origin) return;
            PlayerPrefs.DeleteKey(Key);
            PlayerPrefs.Save();
        }
    }

    /// <summary>Set-Cookie 응답 헤더에서 세션 쿠키를 꺼낸다. 서버 토큰 형식은 base64url 43자다(server/src/ranked.ts).</summary>
    static class RankedSessionCookie
    {
        public const string Name = "ember_sid";
        const long DefaultMaxAgeSeconds = 7L * 24 * 60 * 60;

        static readonly Regex Sid = new Regex(@"(?:^|[\s,;])ember_sid=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])", RegexOptions.CultureInvariant);
        static readonly Regex MaxAge = new Regex(@";\s*Max-Age=(\d{1,10})", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        static readonly Regex SecureAttr = new Regex(@";\s*Secure\s*(?:;|,|$)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

        public static bool IsValidToken(string token)
        {
            return token != null && token.Length == 43 && Sid.IsMatch(Name + "=" + token);
        }

        /// <summary>헤더에 ember_sid가 없으면 null. Max-Age=0(삭제 지시)도 null로 돌려 세션을 쓰지 않게 한다.</summary>
        public static RankedSession Parse(string setCookie, long nowUnix)
        {
            if (string.IsNullOrEmpty(setCookie)) return null;
            Match m = Sid.Match(setCookie);
            if (!m.Success) return null;
            // 여러 쿠키가 한 문자열로 합쳐졌을 수 있으므로 이 쿠키의 속성은 다음 ember_sid 직전까지만 본다.
            int start = m.Groups[1].Index + m.Groups[1].Length;
            int next = setCookie.IndexOf(Name + "=", start, StringComparison.Ordinal);
            string attrs = next < 0 ? setCookie.Substring(start) : setCookie.Substring(start, next - start);
            long maxAge = DefaultMaxAgeSeconds;
            Match age = MaxAge.Match(attrs);
            if (age.Success) long.TryParse(age.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out maxAge);
            if (maxAge <= 0) return null;
            return new RankedSession
            {
                Token = m.Groups[1].Value,
                ExpiresAtUnix = nowUnix + maxAge,
                Secure = SecureAttr.IsMatch(attrs),
            };
        }
    }
}
