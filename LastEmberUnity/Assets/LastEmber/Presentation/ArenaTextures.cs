using UnityEngine;

namespace LastEmber.UnityClient
{
    /// <summary>
    /// 코드로 만드는 텍스처. 빛 번짐(glow), 원판(disc), 흰 단색(solid)을 한 장에 모아 두어
    /// 알파/가산 합성 배치가 각각 한 머티리얼로 끝나게 한다.
    /// </summary>
    internal static class ArenaTextures
    {
        const int Size = 128;
        const int Cell = 64;
        public const float DiscRadiusPx = 30f; // 원판이 칸 안에서 차지하는 반지름(가장자리 번짐 여유 포함)

        public static readonly UvRect Glow = new UvRect(0f, 0f, 0.5f, 0.5f);
        public static readonly UvRect Disc = new UvRect(0.5f, 0f, 1f, 0.5f);
        public static readonly UvRect Solid = new UvRect(4f / Size, 68f / Size, 12f / Size, 76f / Size);

        public static Texture2D CreateAtlas()
        {
            Color32[] px = new Color32[Size * Size];
            Color32 clear = new Color32(255, 255, 255, 0);
            for (int i = 0; i < px.Length; i++) px[i] = clear;

            for (int y = 0; y < Cell; y++)
            {
                for (int x = 0; x < Cell; x++)
                {
                    float dx = x + 0.5f - Cell / 2f;
                    float dy = y + 0.5f - Cell / 2f;
                    float d = Mathf.Sqrt(dx * dx + dy * dy);

                    // 중심 1.0 → 35% 지점 0x55/255 → 가장자리 0 (웹의 radialGradient와 같은 정지점)
                    float n = d / (Cell / 2f);
                    float glow = n < 0.35f ? Mathf.Lerp(1f, 85f / 255f, n / 0.35f)
                        : n < 1f ? Mathf.Lerp(85f / 255f, 0f, (n - 0.35f) / 0.65f)
                        : 0f;
                    px[y * Size + x] = new Color32(255, 255, 255, (byte)Mathf.RoundToInt(glow * 255f));

                    float disc = Mathf.Clamp01(DiscRadiusPx - d);
                    px[y * Size + Cell + x] = new Color32(255, 255, 255, (byte)Mathf.RoundToInt(disc * 255f));
                }
            }

            Color32 white = new Color32(255, 255, 255, 255);
            for (int y = 64; y < 80; y++)
            {
                for (int x = 0; x < 16; x++) px[y * Size + x] = white;
            }

            Texture2D tex = new Texture2D(Size, Size, TextureFormat.RGBA32, false)
            {
                name = "lastember-fx-atlas",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp,
            };
            tex.SetPixels32(px);
            tex.Apply(false, true);
            return tex;
        }

        /// <summary>
        /// 화면 가장자리를 어둡게 하는 비네트 알파 마스크. 화면 비율에 맞춘 크기로 만들어
        /// 웹의 원형 radialGradient(안쪽 반지름 min*0.35, 바깥 max*0.75)와 같은 모양이 되게 한다.
        /// </summary>
        public static void FillVignette(ref Texture2D tex, int screenW, int screenH)
        {
            int w = 64;
            int h = Mathf.Clamp(Mathf.RoundToInt(w * (float)screenH / Mathf.Max(1, screenW)), 16, 256);
            if (screenH < screenW)
            {
                h = 64;
                w = Mathf.Clamp(Mathf.RoundToInt(h * (float)screenW / Mathf.Max(1, screenH)), 16, 256);
            }

            if (tex == null || tex.width != w || tex.height != h)
            {
                if (tex != null) Object.Destroy(tex);
                tex = new Texture2D(w, h, TextureFormat.RGBA32, false)
                {
                    name = "lastember-vignette",
                    filterMode = FilterMode.Bilinear,
                    wrapMode = TextureWrapMode.Clamp,
                };
            }

            float inner = Mathf.Min(screenW, screenH) * 0.35f;
            float outer = Mathf.Max(screenW, screenH) * 0.75f;
            Color32[] px = new Color32[w * h];
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    float dx = ((x + 0.5f) / w - 0.5f) * screenW;
                    float dy = ((y + 0.5f) / h - 0.5f) * screenH;
                    float t = Mathf.Clamp01((Mathf.Sqrt(dx * dx + dy * dy) - inner) / (outer - inner));
                    px[y * w + x] = new Color32(255, 255, 255, (byte)Mathf.RoundToInt(t * 255f));
                }
            }

            tex.SetPixels32(px);
            tex.Apply(false, false);
        }
    }
}
