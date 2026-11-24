using System.Collections.Generic;
using LastEmber.Core;
using UnityEngine;
using UnityEngine.Rendering;

namespace LastEmber.UnityClient
{
    /// <summary>카메라가 본 화면 정보. 길이는 모두 시뮬레이션 단위, 화면 크기는 픽셀.</summary>
    internal struct ViewInfo
    {
        public float CamX, CamY;        // 흔들림이 반영된 카메라 중심
        public float HalfW, HalfH;      // 보이는 월드 범위의 절반
        public float Zoom;              // 픽셀당 시뮬레이션 단위의 역수(시뮬레이션 단위 1 = Zoom 픽셀)
        public float ScreenW, ScreenH;  // 픽셀
        public float Dp;                // 웹의 CSS 픽셀에 해당하는 화면 픽셀 수(UI 크기 보정)
        public Rect Safe;               // 픽셀 단위 안전 영역(y는 아래에서 위로)
    }

    /// <summary>
    /// 시뮬레이션 상태를 읽어 사각형 배치로 그린다(client/src/render.ts의 포팅). 상태는 읽기만 한다.
    /// 그리기 순서는 웹과 같다: 바닥 → 위험 예고 → 가산 빛 번짐 → 일반 합성 외곽/스프라이트 → 화면 고정 레이어.
    /// 60Hz 시뮬레이션 사이는 이전 틱 위치(Px, Py)와 현재 위치를 alpha로 보간한다.
    /// </summary>
    internal sealed class ArenaPainter
    {
        static readonly Color32[] KindColor =
        {
            new Color32(255, 93, 115, 255), new Color32(255, 162, 77, 255), new Color32(179, 136, 255, 255),
            new Color32(77, 226, 197, 255), new Color32(255, 79, 216, 255), new Color32(255, 225, 77, 255),
        };

        static readonly Color32 EliteColor = new Color32(255, 210, 63, 255);
        static readonly Color32 White = new Color32(255, 255, 255, 255);

        const float PlayerSpriteSize = (float)Defs.PlayerR * 4.7f;
        const float PlayerSpritePivot = 0.605f;
        const float DT = (float)Defs.DT;

        // 적 종류별 스프라이트 크기(반지름 배수)와 충돌 중심이 놓이는 가로 비율
        static readonly float[] EnemyScale = { 2.5f, 3.6f, 2.5f, 2.5f, 2.2f, 2.5f };
        static readonly float[] EnemyPivot = { 0.415f, 0.35f, 0.5f, 0.43f, 0.4f, 0.5f };
        static readonly string[] EnemyTextures =
        {
            "LastEmber/sprites/chaser", "LastEmber/sprites/runner", "LastEmber/sprites/tank",
            "LastEmber/sprites/shooter", "LastEmber/sprites/abyssal-core", "LastEmber/sprites/bomber",
        };

        // 정렬 순서(작을수록 뒤)
        const int OrderFloor = 0, OrderGround = 1, OrderAdd = 10, OrderGem = 20, OrderEnemy = 30,
            OrderMid = 50, OrderPlayer = 60, OrderOverlay = 85, OrderVignette = 90, OrderTop = 95;

        public const int OrderText = 70;

        readonly Transform root;
        readonly Shader shader;
        readonly Texture2D atlas;
        readonly Texture2D floorTex;
        Texture2D vignetteTex;
        int vignetteW, vignetteH;

        readonly QuadBatch floor, ground, add, gems, mid, overlay, top;
        QuadBatch vignette;
        readonly QuadBatch[] enemy = new QuadBatch[6];
        readonly QuadBatch[] enemyFlash = new QuadBatch[6];
        readonly Texture2D[] enemyTex = new Texture2D[6];
        QuadBatch player, playerFlash;
        readonly Texture2D playerTex;
        readonly QuadBatch[] all;
        readonly List<Material> materials = new List<Material>();

        readonly double[] bladeDirs = new double[16];

        // 프레임마다 채우는 값
        Sim sim;
        float alpha, time, px, py, vx0, vx1, vy0, vy1;

        /// <summary>마지막 프레임에 실제로 그린 적 수(디버그 표시용).</summary>
        public int EnemiesDrawn;

        public ArenaPainter(Transform root, Shader shader)
        {
            this.root = root;
            this.shader = shader;
            atlas = ArenaTextures.CreateAtlas();
            floorTex = LoadTexture("LastEmber/environment/arena-floor", FilterMode.Point, TextureWrapMode.Repeat);
            playerTex = LoadTexture("LastEmber/sprites/player-ember-v2", FilterMode.Bilinear, TextureWrapMode.Clamp);

            floor = floorTex != null ? Batch("floor", floorTex, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderFloor, 4) : null;
            ground = Batch("ground", atlas, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderGround, 256);
            add = Batch("add", atlas, BlendMode.SrcAlpha, BlendMode.One, false, OrderAdd, 2048);
            gems = Batch("gems", atlas, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderGem, 512);
            for (int k = 0; k < 6; k++)
            {
                enemyTex[k] = LoadTexture(EnemyTextures[k], FilterMode.Bilinear, TextureWrapMode.Clamp);
                if (enemyTex[k] == null) continue;
                enemy[k] = Batch("enemy" + k, enemyTex[k], BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderEnemy + k * 2, 128);
                enemyFlash[k] = Batch("enemyFlash" + k, enemyTex[k], BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, true, OrderEnemy + k * 2 + 1, 32);
            }

            mid = Batch("mid", atlas, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderMid, 512);
            if (playerTex != null)
            {
                player = Batch("player", playerTex, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderPlayer, 8);
                playerFlash = Batch("playerFlash", playerTex, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, true, OrderPlayer + 1, 4);
            }

            overlay = Batch("overlay", atlas, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderOverlay, 8);
            top = Batch("top", atlas, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderTop, 4);

            List<QuadBatch> list = new List<QuadBatch> { ground, add, gems, mid, overlay, top };
            if (floor != null) list.Add(floor);
            for (int k = 0; k < 6; k++)
            {
                if (enemy[k] != null) list.Add(enemy[k]);
                if (enemyFlash[k] != null) list.Add(enemyFlash[k]);
            }

            if (player != null)
            {
                list.Add(player);
                list.Add(playerFlash);
            }

            all = list.ToArray();
        }

        static Texture2D LoadTexture(string path, FilterMode filter, TextureWrapMode wrap)
        {
            Texture2D t = Resources.Load<Texture2D>(path);
            if (t == null)
            {
                Debug.LogWarning("[ArenaView] missing texture Resources/" + path);
                return null;
            }

            t.filterMode = filter;
            t.wrapMode = wrap;
            return t;
        }

        QuadBatch Batch(string name, Texture tex, BlendMode src, BlendMode dst, bool flash, int order, int capacity)
        {
            Material m = new Material(shader) { name = "lastember-" + name, mainTexture = tex };
            m.SetFloat("_SrcBlend", (float)src);
            m.SetFloat("_DstBlend", (float)dst);
            m.SetFloat("_Flash", flash ? 1f : 0f);
            materials.Add(m);
            return new QuadBatch(root, name, m, order, capacity);
        }

        public void Destroy()
        {
            if (all != null)
            {
                for (int i = 0; i < all.Length; i++) all[i].Destroy();
            }

            if (vignette != null) vignette.Destroy();
            for (int i = 0; i < materials.Count; i++) Object.Destroy(materials[i]);
            Object.Destroy(atlas);
            if (vignetteTex != null) Object.Destroy(vignetteTex);
        }

        // ───────────────────────── 그리기 도구 ─────────────────────────

        static float Lerp(double prev, double cur, float a)
        {
            return (float)(prev + (cur - prev) * a);
        }

        static Color32 Alpha(Color32 c, float a)
        {
            return new Color32(c.r, c.g, c.b, (byte)Mathf.Clamp(Mathf.RoundToInt(a * 255f), 0, 255));
        }

        static Color32 Rgba(int r, int g, int b, float a)
        {
            return new Color32((byte)r, (byte)g, (byte)b, (byte)Mathf.Clamp(Mathf.RoundToInt(a * 255f), 0, 255));
        }

        static void Fill(QuadBatch b, float x, float y, float w, float h, Color32 c)
        {
            b.Add(x, y, x + w, y, x + w, y + h, x, y + h, ArenaTextures.Solid, c);
        }

        static void Glow(QuadBatch b, float x, float y, float size, Color32 c)
        {
            float h = size * 0.5f;
            b.Add(x - h, y - h, x + h, y - h, x + h, y + h, x - h, y + h, ArenaTextures.Glow, c);
        }

        static void Disc(QuadBatch b, float x, float y, float r, Color32 c)
        {
            float h = r * (ArenaTextures.DiscRadiusPx > 0f ? 32f / ArenaTextures.DiscRadiusPx : 1f);
            b.Add(x - h, y - h, x + h, y - h, x + h, y + h, x - h, y + h, ArenaTextures.Disc, c);
        }

        static void Line(QuadBatch b, float x0, float y0, float x1, float y1, float w, Color32 c)
        {
            float dx = x1 - x0;
            float dy = y1 - y0;
            float len = Mathf.Sqrt(dx * dx + dy * dy);
            if (len < 1e-4f) return;
            float nx = -dy / len * w * 0.5f;
            float ny = dx / len * w * 0.5f;
            b.Add(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, ArenaTextures.Solid, c);
        }

        static void Diamond(QuadBatch b, float x, float y, float r, Color32 c)
        {
            b.Add(x, y - r, x + r, y, x, y + r, x - r, y, ArenaTextures.Solid, c);
        }

        /// <summary>중심이 (cx, cy)이고 (ux, uy) 방향을 +x로 보는 좌표계의 사각형. 로컬 y는 시뮬레이션처럼 아래로 증가.</summary>
        static void LocalRect(QuadBatch b, float cx, float cy, float ux, float uy,
            float x0, float y0, float x1, float y1, in UvRect uv, Color32 c)
        {
            b.Add(cx + x0 * ux - y0 * uy, cy + x0 * uy + y0 * ux,
                cx + x1 * ux - y0 * uy, cy + x1 * uy + y0 * ux,
                cx + x1 * ux - y1 * uy, cy + x1 * uy + y1 * ux,
                cx + x0 * ux - y1 * uy, cy + x0 * uy + y1 * ux,
                uv, c);
        }

        static readonly UvRect FullUv = new UvRect(0f, 0f, 1f, 1f);

        static void SpriteQuad(QuadBatch b, float x, float y, float ux, float uy, float size, float pivot, Color32 c)
        {
            LocalRect(b, x, y, ux, uy, -size * pivot, -size * 0.5f, size * (1f - pivot), size * 0.5f, FullUv, c);
        }

        /// <summary>두께 w인 원 테두리를 호 조각으로 이어 그린다. dashed면 한 칸 걸러 그린다.</summary>
        static void RingStroke(QuadBatch b, float cx, float cy, float r, float w, Color32 c, bool dashed = false)
        {
            int seg = Mathf.Clamp(Mathf.CeilToInt(r * 0.25f), 12, 48);
            float ro = r + w * 0.5f;
            float ri = Mathf.Max(0f, r - w * 0.5f);
            float step = Mathf.PI * 2f / seg;
            float c0 = 1f, s0 = 0f;
            for (int i = 0; i < seg; i++)
            {
                float a1 = (i + 1) * step;
                float c1 = Mathf.Cos(a1), s1 = Mathf.Sin(a1);
                if (!dashed || (i & 1) == 0)
                {
                    b.Add(cx + c0 * ro, cy + s0 * ro, cx + c1 * ro, cy + s1 * ro,
                        cx + c1 * ri, cy + s1 * ri, cx + c0 * ri, cy + s0 * ri, ArenaTextures.Solid, c);
                }

                c0 = c1;
                s0 = s1;
            }
        }

        bool InView(double x, double y)
        {
            return x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
        }

        // ───────────────────────── 한 프레임 ─────────────────────────

        public void Paint(Sim s, float a, ArenaFx fx, float t, bool showPlayer, in ViewInfo v)
        {
            sim = s;
            alpha = a;
            time = t;
            Player p = s.Player;
            px = Lerp(p.Px, p.X, a);
            py = Lerp(p.Py, p.Y, a);
            vx0 = v.CamX - v.HalfW - 60f;
            vx1 = v.CamX + v.HalfW + 60f;
            vy0 = v.CamY - v.HalfH - 60f;
            vy1 = v.CamY + v.HalfH + 60f;

            for (int i = 0; i < all.Length; i++) all[i].Begin();
            EnsureVignette(v);
            vignette.Begin();

            PaintFloor();
            PaintTelegraphs();
            PaintGlows(fx, showPlayer);
            PaintShapes(showPlayer);
            PaintPlayer(showPlayer);
            PaintScreenLayer(fx, showPlayer, v);

            for (int i = 0; i < all.Length; i++) all[i].End();
            vignette.End();
            sim = null;
        }

        void EnsureVignette(in ViewInfo v)
        {
            int w = Mathf.RoundToInt(v.ScreenW);
            int h = Mathf.RoundToInt(v.ScreenH);
            if (vignette != null && vignetteW == w && vignetteH == h) return;
            vignetteW = w;
            vignetteH = h;
            ArenaTextures.FillVignette(ref vignetteTex, w, h);
            if (vignette == null)
            {
                vignette = Batch("vignette", vignetteTex, BlendMode.SrcAlpha, BlendMode.OneMinusSrcAlpha, false, OrderVignette, 4);
            }
            else
            {
                vignette.Material.mainTexture = vignetteTex;
            }
        }

        // 바닥과 격자
        void PaintFloor()
        {
            const float arena = (float)Defs.Arena;
            if (floor != null)
            {
                // 타일 한 장이 가로세로 텍스처 픽셀 수만큼의 시뮬레이션 단위를 덮는다(웹의 createPattern과 같다).
                float tiles = arena / floorTex.width;
                float tilesV = arena / floorTex.height;
                floor.Add(0f, 0f, arena, 0f, arena, arena, 0f, arena, 0f, 5f - tilesV, tiles, 5f, White);
            }
            else
            {
                Fill(ground, 0f, 0f, arena, arena, new Color32(10, 12, 22, 255));
            }

            Color32 grid = Rgba(120, 140, 255, 0.07f);
            float gx0 = Mathf.Max(0f, Mathf.Floor(vx0 / 80f) * 80f);
            float gy0 = Mathf.Max(0f, Mathf.Floor(vy0 / 80f) * 80f);
            float ya = Mathf.Max(0f, vy0), yb = Mathf.Min(arena, vy1);
            float xa = Mathf.Max(0f, vx0), xb = Mathf.Min(arena, vx1);
            for (float x = gx0; x <= Mathf.Min(arena, vx1); x += 80f) Fill(ground, x - 0.5f, ya, 1f, yb - ya, grid);
            for (float y = gy0; y <= Mathf.Min(arena, vy1); y += 80f) Fill(ground, xa, y - 0.5f, xb - xa, 1f, grid);

            Color32 border = new Color32(84, 104, 255, 255);
            Fill(ground, -2f, -2f, arena + 4f, 4f, border);
            Fill(ground, -2f, arena - 2f, arena + 4f, 4f, border);
            Fill(ground, -2f, -2f, 4f, arena + 4f, border);
            Fill(ground, arena - 2f, -2f, 4f, arena + 4f, border);
        }

        // 위험 예고 (바닥에 깔리는 표시)
        void PaintTelegraphs()
        {
            List<Enemy> es = sim.Enemies;
            float chargeLen = (float)(Defs.ChargeSpeed * Defs.ChargeDash * (1.0 / 60));
            for (int i = 0; i < es.Count; i++)
            {
                Enemy e = es[i];
                if (e.Mode != 1) continue;
                if (e.X < vx0 - 200 || e.X > vx1 + 200 || e.Y < vy0 - 200 || e.Y > vy1 + 200) continue;
                float x = Lerp(e.Px, e.X, alpha);
                float y = Lerp(e.Py, e.Y, alpha);
                if (e.Kind == Kind.Bomber)
                {
                    // 도화선: 폭발 범위를 채워 가며, 끝에 가까울수록 빠르게 깜빡인다
                    float f = 1f - e.Timer / (float)Defs.BomberFuse;
                    float blink = Mathf.Sin(time * (10f + f * 30f)) > 0f ? 1f : 0.6f;
                    float rad = (float)Defs.BomberRadius;
                    Disc(ground, x, y, rad, Rgba(255, 90, 40, (0.08f + f * 0.22f) * blink));
                    RingStroke(ground, x, y, rad, 2f, Rgba(255, 120, 60, 0.5f + f * 0.5f));
                    Disc(ground, x, y, rad * f, Rgba(255, 140, 60, 0.18f));
                }
                else if (e.Kind == Kind.Boss)
                {
                    // 돌진 예고선: 조준이 고정되면 진하게 바뀐다
                    bool locked = e.Timer <= Defs.ChargeLock;
                    Color32 c = locked ? Rgba(255, 60, 120, 0.32f) : Rgba(255, 80, 200, 0.1f + 0.08f * Mathf.Sin(time * 20f));
                    float r = (float)e.R;
                    LocalRect(ground, x, y, (float)e.Ax, (float)e.Ay, 0f, -r, chargeLen, r, ArenaTextures.Solid, c);
                }
            }
        }

        // 가산 합성 레이어: 빛 번짐
        void PaintGlows(ArenaFx fx, bool showPlayer)
        {
            Sim s = sim;
            Player p = s.Player;
            List<Gem> gs = s.Gems;
            Color32 gemGlow = new Color32(93, 242, 192, 255);
            for (int i = 0; i < gs.Count; i++)
            {
                Gem g = gs[i];
                if (!InView(g.X, g.Y)) continue;
                Glow(add, Lerp(g.Px, g.X, alpha), Lerp(g.Py, g.Y, alpha), g.Value >= 3 ? 26f : 18f, gemGlow);
            }

            EnemiesDrawn = 0;
            List<Enemy> es = s.Enemies;
            for (int i = 0; i < es.Count; i++)
            {
                Enemy e = es[i];
                if (!InView(e.X, e.Y)) continue;
                float x = Lerp(e.Px, e.X, alpha);
                float y = Lerp(e.Py, e.Y, alpha);
                float r = (float)e.R;
                Glow(add, x, y, r * 4.6f, KindColor[e.Kind]);
                if (e.Elite) Glow(add, x, y, r * (5.5f + 0.6f * Mathf.Sin(time * 5f)), EliteColor);
                EnemiesDrawn++;
            }

            // 보물 상자
            List<Chest> cs = s.Chests;
            for (int i = 0; i < cs.Count; i++)
            {
                Glow(add, (float)cs[i].X, (float)cs[i].Y, 70f + 10f * Mathf.Sin(time * 4f), EliteColor);
            }

            // 플레이어 탄환: 진행 방향 반대로 꼬리를 그린다 (태양창은 빛을 두른다)
            bool lance = s.Levels[Up.SunLance] > 0;
            List<Bullet> bs = s.Bullets;
            Color32 lanceGlow = new Color32(255, 210, 63, 255);
            Color32 tail = lance ? new Color32(255, 243, 176, 255) : new Color32(255, 210, 122, 255);
            for (int i = 0; i < bs.Count; i++)
            {
                Bullet b = bs[i];
                if (b.Hostile) continue;
                float x = Lerp(b.Px, b.X, alpha);
                float y = Lerp(b.Py, b.Y, alpha);
                if (lance) Glow(add, x, y, 32f, lanceGlow);
                Line(add, x - (float)b.Vx * 0.035f, y - (float)b.Vy * 0.035f, x, y, lance ? 5f : 3.5f, tail);
            }

            Color32 hostileGlow = new Color32(255, 51, 85, 255);
            for (int i = 0; i < bs.Count; i++)
            {
                Bullet b = bs[i];
                if (!b.Hostile || !InView(b.X, b.Y)) continue;
                Glow(add, Lerp(b.Px, b.X, alpha), Lerp(b.Py, b.Y, alpha), 28f, hostileGlow);
            }

            // 공전 칼날
            int blades = showPlayer ? s.OrbitBlades(bladeDirs) : 0;
            if (blades > 0)
            {
                float radius = (float)s.OrbitRadiusNow();
                bool tempest = s.Levels[Up.Tempest] > 0;
                RingStroke(add, px, py, radius, 2f, tempest ? Rgba(79, 217, 255, 0.28f) : Rgba(127, 227, 255, 0.10f));
                Color32 bladeGlow = new Color32(127, 227, 255, 255);
                for (int i = 0; i < blades; i++)
                {
                    Glow(add, px + (float)bladeDirs[i * 2] * radius, py + (float)bladeDirs[i * 2 + 1] * radius, 60f, bladeGlow);
                }
            }

            for (int i = 0; i < fx.RingCount; i++)
            {
                ArenaFx.Ring r = fx.Rings[i];
                float k = 1f - r.Life / r.Max;
                RingStroke(add, r.X, r.Y, r.R * (0.25f + 0.75f * k), 10f * (1f - k) + 2f, Alpha(r.Color, 1f - k));
            }

            // 연쇄 번개: 매 프레임 지그재그를 새로 만들어 떨리게 한다
            Color32 bolt = new Color32(255, 242, 122, 255);
            for (int i = 0; i < fx.BoltCount; i++)
            {
                ArenaFx.Bolt b = fx.Bolts[i];
                if (b.Count < 4) continue;
                float[] pts = b.Points;
                float lx = pts[0], ly = pts[1];
                for (int k = 2; k + 1 < b.Count; k += 2)
                {
                    float mx = (pts[k - 2] + pts[k]) * 0.5f + (Random.value - 0.5f) * 26f;
                    float my = (pts[k - 1] + pts[k + 1]) * 0.5f + (Random.value - 0.5f) * 26f;
                    Line(add, lx, ly, mx, my, 3f, bolt);
                    Line(add, mx, my, pts[k], pts[k + 1], 3f, bolt);
                    lx = pts[k];
                    ly = pts[k + 1];
                }
            }

            for (int i = 0; i < fx.ParticleCount; i++)
            {
                ref ArenaFx.Particle q = ref fx.Particles[i];
                float h = q.Size * 0.5f;
                Color32 c = Alpha(q.Color, q.Life / q.Max);
                add.Add(q.X - h, q.Y - h, q.X + h, q.Y - h, q.X + h, q.Y + h, q.X - h, q.Y + h, ArenaTextures.Solid, c);
            }

            if (showPlayer)
            {
                Glow(add, px, py, p.DashT > 0 ? 150f : 110f, new Color32(255, 179, 71, 255));
            }
        }

        // 일반 합성 레이어: 선명한 외곽선과 스프라이트
        void PaintShapes(bool showPlayer)
        {
            Sim s = sim;
            List<Gem> gs = s.Gems;
            Color32 gemColor = new Color32(185, 255, 233, 255);
            for (int i = 0; i < gs.Count; i++)
            {
                Gem g = gs[i];
                if (!InView(g.X, g.Y)) continue;
                Diamond(gems, Lerp(g.Px, g.X, alpha), Lerp(g.Py, g.Y, alpha), g.Value >= 3 ? 6f : 4f, gemColor);
            }

            List<Enemy> es = s.Enemies;
            float spin = time * 0.8f;
            for (int i = 0; i < es.Count; i++)
            {
                Enemy e = es[i];
                if (!InView(e.X, e.Y)) continue;
                int kind = e.Kind;
                float x = Lerp(e.Px, e.X, alpha);
                float y = Lerp(e.Py, e.Y, alpha);
                float ux = 1f, uy = 0f;
                if (kind == Kind.Boss)
                {
                    ux = e.Mode == 0 ? Mathf.Cos(spin) : (float)e.Ax;
                    uy = e.Mode == 0 ? Mathf.Sin(spin) : (float)e.Ay;
                }
                else if (kind != Kind.Tank)
                {
                    float dx = px - x;
                    float dy = py - y;
                    float d = Mathf.Sqrt(dx * dx + dy * dy);
                    if (d > 0f)
                    {
                        ux = dx / d;
                        uy = dy / d;
                    }
                }

                float r = (float)e.R;
                bool flash = e.Flash > 0;
                QuadBatch batch = flash ? enemyFlash[kind] : enemy[kind];
                if (batch != null)
                {
                    // 비대칭 스프라이트의 코어가 충돌 중심에 놓이도록 보정한다.
                    SpriteQuad(batch, x, y, ux, uy, r * EnemyScale[kind], EnemyPivot[kind], White);
                }
                else
                {
                    // 텍스처를 못 읽었을 때의 대체 표시
                    Disc(mid, x, y, r, flash ? White : KindColor[kind]);
                }
            }

            // 엘리트 금테, 마비 표시, 체력이 깎인 탱크·엘리트의 체력 바
            for (int i = 0; i < es.Count; i++)
            {
                Enemy e = es[i];
                if (!InView(e.X, e.Y)) continue;
                float x = Lerp(e.Px, e.X, alpha);
                float y = Lerp(e.Py, e.Y, alpha);
                float r = (float)e.R;
                if (e.Elite) RingStroke(mid, x, y, r + 6f, 3f, EliteColor);
                if (e.Stun > 0) RingStroke(mid, x, y, r + 3f, 1.5f, Rgba(255, 247, 176, 0.85f), true);
                if (e.Kind != Kind.Tank || e.Hp >= e.MaxHp) continue;
                float w = e.Elite ? 60f : 36f;
                float hgt = e.Elite ? 6f : 4f;
                Fill(mid, x - w / 2f, y - r - 12f, w, hgt, Rgba(0, 0, 0, 0.6f));
                Fill(mid, x - w / 2f, y - r - 12f, w * Mathf.Max(0f, (float)(e.Hp / e.MaxHp)), hgt,
                    e.Elite ? EliteColor : KindColor[Kind.Tank]);
            }

            // 보물 상자 본체
            List<Chest> cs = s.Chests;
            Color32 chestBody = new Color32(90, 59, 16, 255);
            for (int i = 0; i < cs.Count; i++)
            {
                float cx = (float)cs[i].X;
                float cy = (float)cs[i].Y + Mathf.Sin(time * 4f) * 2f;
                Fill(mid, cx - 12f, cy - 9f, 24f, 18f, chestBody);
                Fill(mid, cx - 13.25f, cy - 10.25f, 26.5f, 2.5f, EliteColor);
                Fill(mid, cx - 13.25f, cy + 7.75f, 26.5f, 2.5f, EliteColor);
                Fill(mid, cx - 13.25f, cy - 10.25f, 2.5f, 20.5f, EliteColor);
                Fill(mid, cx + 10.75f, cy - 10.25f, 2.5f, 20.5f, EliteColor);
                Fill(mid, cx - 12f, cy - 2f, 24f, 3f, EliteColor);
                Fill(mid, cx - 2.5f, cy - 4f, 5f, 7f, EliteColor);
            }

            List<Bullet> bs = s.Bullets;
            Color32 hostileCore = new Color32(255, 208, 216, 255);
            for (int i = 0; i < bs.Count; i++)
            {
                Bullet b = bs[i];
                if (!b.Hostile || !InView(b.X, b.Y)) continue;
                Disc(mid, Lerp(b.Px, b.X, alpha), Lerp(b.Py, b.Y, alpha), 4.5f, hostileCore);
            }

            int blades = showPlayer ? s.OrbitBlades(bladeDirs) : 0;
            if (blades > 0)
            {
                float radius = (float)s.OrbitRadiusNow();
                Color32 core = s.Levels[Up.Tempest] > 0 ? new Color32(184, 243, 255, 255) : new Color32(232, 251, 255, 255);
                for (int i = 0; i < blades; i++)
                {
                    Disc(mid, px + (float)bladeDirs[i * 2] * radius, py + (float)bladeDirs[i * 2 + 1] * radius, 7f, core);
                }
            }
        }

        void PaintPlayer(bool showPlayer)
        {
            if (!showPlayer) return;
            Player p = sim.Player;
            // 피격 무적 중에는 깜빡인다
            bool blink = p.Iframes > 0 && ((int)(time * 20f) & 1) == 0;
            if (blink) return;
            float fx = (float)p.Fx, fy = (float)p.Fy;
            if (player == null)
            {
                Disc(mid, px, py, (float)Defs.PlayerR, p.DashT > 0 ? White : new Color32(255, 241, 207, 255));
                Disc(mid, px + fx * 5f, py + fy * 5f, 3.5f, new Color32(255, 122, 26, 255));
                return;
            }

            if (p.DashT > 0)
            {
                SpriteQuad(playerFlash, px, py, fx, fy, PlayerSpriteSize, PlayerSpritePivot, White);
                return;
            }

            PlayerFlame(px, py, fx, fy, (sim.Tick + alpha) * DT);
        }

        /// <summary>
        /// 불씨 꼬리: 코어 앞쪽은 고정하고 이음새 뒤쪽만 늘리거나 휘게 한다.
        /// 웹의 ctx.transform(stretch, shear, 0, 1, joint, 0)과 같은 변환을 직접 계산한다.
        /// </summary>
        void PlayerFlame(float x, float y, float ux, float uy, float t)
        {
            float size = PlayerSpriteSize;
            float width = playerTex.width;
            float split = Mathf.Round(width * 0.44f);
            float tailWidth = size * split / width;
            float joint = tailWidth - size * PlayerSpritePivot;

            Color32 spark = new Color32(255, 186, 88, 255);
            for (int i = 0; i < 4; i++)
            {
                float age = Mathf.Repeat(t * 2.6f + i * 0.25f, 1f);
                float lx = -24f - age * (24f + i * 3f);
                float ly = (i - 1.5f) * (5f + age * 6f);
                Disc(mid, x + lx * ux - ly * uy, y + lx * uy + ly * ux, 1.5f - age, Alpha(spark, 0.8f * (1f - age)));
            }

            float stretch = 1f + 0.17f * Mathf.Sin(t * 18f) + 0.07f * Mathf.Sin(t * 29f);
            float shear = 0.14f * Mathf.Sin(t * 15f);
            float x0 = -tailWidth, x1 = size / width, y0 = -size * 0.5f, y1 = size * 0.5f;
            float uEnd = (split + 1f) / width;
            // 꼬리 조각: 로컬 (X, Y) → (stretch*X + joint, shear*X + Y) → 회전/이동
            TailCorner(x, y, ux, uy, stretch, shear, joint, x0, y0, out float ax, out float ay);
            TailCorner(x, y, ux, uy, stretch, shear, joint, x1, y0, out float bx, out float by);
            TailCorner(x, y, ux, uy, stretch, shear, joint, x1, y1, out float cx, out float cy);
            TailCorner(x, y, ux, uy, stretch, shear, joint, x0, y1, out float dx, out float dy);
            player.Add(ax, ay, bx, by, cx, cy, dx, dy, 0f, 0f, uEnd, 1f, White);

            // 머리 조각
            LocalRect(player, x, y, ux, uy, joint, y0, joint + size - tailWidth, y1, new UvRect(split / width, 0f, 1f, 1f), White);
        }

        static void TailCorner(float x, float y, float ux, float uy, float stretch, float shear, float joint,
            float lx, float ly, out float wx, out float wy)
        {
            float X = stretch * lx + joint;
            float Y = shear * lx + ly;
            wx = x + X * ux - Y * uy;
            wy = y + X * uy + Y * ux;
        }

        // 화면 고정 레이어
        void PaintScreenLayer(ArenaFx fx, bool showPlayer, in ViewInfo v)
        {
            Sim s = sim;
            Player p = s.Player;
            float invZoom = 1f / v.Zoom;

            // 화면 밖 보스 방향 표시
            if (s.BossSpawned && showPlayer)
            {
                List<Enemy> es = s.Enemies;
                for (int i = 0; i < es.Count; i++)
                {
                    Enemy e = es[i];
                    if (e.Kind != Kind.Boss) continue;
                    float dx = (float)e.X - px;
                    float dy = (float)e.Y - py;
                    if (Mathf.Abs(dx) < v.HalfW - 20f && Mathf.Abs(dy) < v.HalfH - 20f) break;
                    BossArrow(dx, dy, v, invZoom);
                    break;
                }
            }

            // 비네트 + 피격/저체력 붉은 테두리
            float lowHp = showPlayer && p.Hp > 0 && p.Hp < p.MaxHp * 0.3 ? 0.25f + 0.12f * Mathf.Sin(time * 6f) : 0f;
            float red = Mathf.Max(fx.Hurt * 0.6f, lowHp);
            Color32 vc = red > 0f
                ? Rgba(Mathf.RoundToInt(120f + 135f * red), 0, Mathf.RoundToInt(30f * red), 0.55f + red * 0.3f)
                : Rgba(0, 0, 0, 0.55f);
            float hw = v.HalfW + 1f, hh = v.HalfH + 1f;
            vignette.Add(v.CamX - hw, v.CamY - hh, v.CamX + hw, v.CamY - hh, v.CamX + hw, v.CamY + hh, v.CamX - hw, v.CamY + hh,
                0f, 0f, 1f, 1f, vc);

            if (fx.Flash > 0f)
            {
                Fill(top, v.CamX - hw, v.CamY - hh, hw * 2f, hh * 2f, Rgba(255, 255, 255, fx.Flash * 0.5f));
            }
        }

        void BossArrow(float dx, float dy, in ViewInfo v, float invZoom)
        {
            float ang = Mathf.Atan2(dy, dx);
            float cos = Mathf.Cos(ang), sin = Mathf.Sin(ang);
            float margin = 36f * v.Dp;
            // 안전 영역 안쪽 사각형(픽셀, y 아래로 증가)에 화면 중심에서 쏜 광선이 닿는 점
            float left = v.Safe.xMin + margin, right = v.Safe.xMax - margin;
            float topPx = v.ScreenH - v.Safe.yMax + margin, bottom = v.ScreenH - v.Safe.yMin - margin;
            float cx = v.ScreenW * 0.5f, cy = v.ScreenH * 0.5f;
            float tx = Mathf.Abs(cos) < 1e-6f ? float.MaxValue : ((cos > 0f ? right : left) - cx) / cos;
            float ty = Mathf.Abs(sin) < 1e-6f ? float.MaxValue : ((sin > 0f ? bottom : topPx) - cy) / sin;
            float k = Mathf.Min(tx, ty);
            // 픽셀 → 시뮬레이션 단위
            float ox = v.CamX + (cos * k + cx - v.ScreenW * 0.5f) * invZoom;
            float oy = v.CamY + (sin * k + cy - v.ScreenH * 0.5f) * invZoom;
            float u = v.Dp * invZoom;
            // 삼각형: 앞 (14, 0), 뒤 (-10, ±10)
            float tipX = ox + cos * 14f * u, tipY = oy + sin * 14f * u;
            float aX = ox + (cos * -10f - sin * 10f) * u, aY = oy + (sin * -10f + cos * 10f) * u;
            float bX = ox + (cos * -10f + sin * 10f) * u, bY = oy + (sin * -10f - cos * 10f) * u;
            overlay.Add(tipX, tipY, tipX, tipY, aX, aY, bX, bY, ArenaTextures.Solid, KindColor[Kind.Boss]);
        }
    }
}
