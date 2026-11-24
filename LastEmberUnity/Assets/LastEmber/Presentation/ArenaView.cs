using LastEmber.Core;
using UnityEngine;
using EventType = LastEmber.Core.EventType;

namespace LastEmber.UnityClient
{
    /// <summary>
    /// 전투 화면 렌더러와 효과음. client/src/render.ts, fx.ts, audio.ts의 Unity 포팅.
    ///
    /// 사용법: 씬의 아무 GameObject에 AddComponent 하고 매 프레임 Render(sim, alpha)를 부른다.
    /// 시뮬레이션이 Step()한 직후에는 PlayEvents(sim)를 부른다(Step 한 번마다 sim.Events가 새로 채워진다).
    /// 카메라(없으면 생성)·메시·오디오 소스는 초기화에서 코드로 만든다. 상태는 읽기만 하고 지형/물리 판단은 하지 않는다.
    ///
    /// 좌표계: 시뮬레이션 (x, y)는 월드 (x * 0.01, -y * 0.01)이다. 시뮬레이션의 Y는 아래로 증가(웹 캔버스와 같음)하므로
    /// 화면 위쪽이 시뮬레이션 -Y다. 입력을 만들 때도 화면 위 = dy -1이다.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ArenaView : MonoBehaviour
    {
        const float CameraZ = -10f;

        // 업그레이드 번호별 색(shared/defs.ts의 UPGRADE_META.color)
        static readonly Color32[] UpgradeColors =
        {
            new Color32(255, 179, 71, 255), new Color32(127, 227, 255, 255), new Color32(199, 155, 255, 255),
            new Color32(255, 242, 122, 255), new Color32(255, 122, 107, 255), new Color32(141, 255, 176, 255),
            new Color32(154, 208, 255, 255), new Color32(255, 111, 145, 255), new Color32(111, 240, 208, 255),
            new Color32(182, 255, 122, 255), new Color32(255, 210, 63, 255), new Color32(79, 217, 255, 255),
            new Color32(125, 255, 168, 255), new Color32(255, 247, 176, 255),
        };

        static readonly Color32[] KindColors =
        {
            new Color32(255, 93, 115, 255), new Color32(255, 162, 77, 255), new Color32(179, 136, 255, 255),
            new Color32(77, 226, 197, 255), new Color32(255, 79, 216, 255), new Color32(255, 225, 77, 255),
        };

        static readonly Color32 Gold = new Color32(255, 210, 63, 255);
        static readonly Color32 WhiteColor = new Color32(255, 255, 255, 255);

        [Tooltip("비워 두면 Camera.main, 그것도 없으면 새로 만든다.")]
        [SerializeField] Camera targetCamera;

        /// <summary>true면 효과음을 내지 않는다(배경 데모 화면). 파티클 같은 시각 효과는 그대로 나온다.</summary>
        public bool Quiet { get; set; }

        /// <summary>false면 플레이어·공전 칼날·보스 방향 표시를 그리지 않는다.</summary>
        public bool ShowPlayer { get; set; } = true;

        /// <summary>마지막 Render에서 실제로 그린 적 수(디버그 표시용).</summary>
        public int EnemiesDrawn => painter != null ? painter.EnemiesDrawn : 0;

        public Camera ViewCamera => cam;

        public bool Muted
        {
            get
            {
                EnsureInit();
                return audio.Muted;
            }
            set
            {
                EnsureInit();
                audio.Muted = value;
            }
        }

        Camera cam;
        Transform root;
        ArenaFx fx;
        ArenaPainter painter;
        ArenaAudio audio;
        ArenaFloatTexts texts;
        bool initialized;
        int fxFrame = -1;

        /// <summary>시뮬레이션 좌표를 월드 좌표로 바꾼다.</summary>
        public static Vector3 SimToWorld(double x, double y)
        {
            return new Vector3((float)x * QuadBatch.WorldPerSim, (float)-y * QuadBatch.WorldPerSim, 0f);
        }

        void Awake()
        {
            EnsureInit();
        }

        void OnEnable()
        {
            if (root != null) root.gameObject.SetActive(true);
        }

        void OnDisable()
        {
            if (root != null) root.gameObject.SetActive(false);
        }

        void OnDestroy()
        {
            if (!initialized) return;
            texts.Destroy();
            painter.Destroy();
            audio.Destroy();
            if (root != null) Destroy(root.gameObject);
        }

        void EnsureInit()
        {
            if (initialized) return;
            initialized = true;

            GameObject rootGo = new GameObject("ArenaViewRoot");
            root = rootGo.transform;

            SetupCamera();

            Shader shader = Resources.Load<Shader>("LastEmber/shaders/ArenaSprite");
            if (shader == null)
            {
                Debug.LogError("[ArenaView] Resources/LastEmber/shaders/ArenaSprite.shader not found; falling back to Sprites/Default (no additive glow).");
                shader = Shader.Find("Sprites/Default");
            }

            fx = new ArenaFx();
            painter = new ArenaPainter(root, shader);
            texts = new ArenaFloatTexts(root, shader, ArenaPainter.OrderText);
            audio = new ArenaAudio(root);
        }

        void SetupCamera()
        {
            cam = targetCamera != null ? targetCamera : Camera.main;
            if (cam == null)
            {
                GameObject go = new GameObject("ArenaCamera");
                go.tag = "MainCamera";
                cam = go.AddComponent<Camera>();
            }

            cam.orthographic = true;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color32(4, 5, 10, 255);
            cam.nearClipPlane = 0.1f;
            cam.farClipPlane = 100f;
            cam.allowHDR = false;
            cam.allowMSAA = false;
            cam.allowDynamicResolution = false;
            cam.transform.rotation = Quaternion.identity;
            cam.transform.position = new Vector3(0f, 0f, CameraZ);

            if (FindAnyObjectByType<AudioListener>() == null) cam.gameObject.AddComponent<AudioListener>();
        }

        /// <summary>새 판을 시작할 때 쌓인 이펙트를 비운다.</summary>
        public void ResetView()
        {
            EnsureInit();
            fx.Clear();
        }

        /// <summary>배경 음악을 켜거나 끈다(끄면 볼륨만 0으로 내리고 위치는 이어 간다).</summary>
        public void SetMusic(bool on)
        {
            EnsureInit();
            audio.SetMusic(on);
        }

        /// <summary>효과음/음악 등 오디오 전용 재생: 메뉴 선택음 등 UI 쪽에서 쓴다.</summary>
        public void PlayPickSound()
        {
            EnsureInit();
            if (!Quiet) audio.Play(Sfx.Pick);
        }

        // ───────────────────────── 그리기 ─────────────────────────

        /// <summary>
        /// 시뮬레이션 상태를 그린다. alpha는 이전 틱과 현재 틱 사이 보간 계수(0~1).
        /// 이펙트는 Time.deltaTime으로 흘러가므로 일시정지(timeScale 0)에서는 멈춘다.
        /// </summary>
        public void Render(Sim sim, float alpha)
        {
            EnsureInit();
            if (sim == null) return;

            if (fxFrame != Time.frameCount)
            {
                fxFrame = Time.frameCount;
                fx.Update(Mathf.Min(Time.deltaTime, 0.05f));
            }

            int w = cam.pixelWidth;
            int h = cam.pixelHeight;
            if (w <= 0 || h <= 0) return;

            // 화면 비율이 달라도 보이는 월드 범위가 1200x700(세로 화면은 700x1200)을 넘지 않게 한다.
            // 대각선 절반이 스폰 링 반지름(720)보다 짧아서 적이 화면 안에서 생겨나 보이지 않는다.
            float zoom = w >= h ? Mathf.Max(w / 1200f, h / 700f) : Mathf.Max(w / 700f, h / 1200f);
            float halfW = w / zoom * 0.5f;
            float halfH = h / zoom * 0.5f;

            Player p = sim.Player;
            float a = Mathf.Clamp01(alpha);
            float camX = (float)(p.Px + (p.X - p.Px) * a) + (Random.value - 0.5f) * fx.Shake;
            float camY = (float)(p.Py + (p.Y - p.Py) * a) + (Random.value - 0.5f) * fx.Shake;

            cam.orthographicSize = halfH * QuadBatch.WorldPerSim;
            cam.transform.position = new Vector3(camX * QuadBatch.WorldPerSim, -camY * QuadBatch.WorldPerSim, CameraZ);

            ViewInfo view = new ViewInfo
            {
                CamX = camX,
                CamY = camY,
                HalfW = halfW,
                HalfH = halfH,
                Zoom = zoom,
                ScreenW = w,
                ScreenH = h,
                Dp = Mathf.Max(1f, Mathf.Min(w, h) / 360f),
                Safe = w == Screen.width && h == Screen.height ? Screen.safeArea : new Rect(0f, 0f, w, h),
            };

            painter.Paint(sim, a, fx, Time.time, ShowPlayer, view);
            texts.Sync(fx);
        }

        // ───────────────────────── 이벤트 → 연출 ─────────────────────────

        /// <summary>
        /// sim.Events(마지막 Step의 결과)를 파티클·링·화면 효과와 효과음으로 바꾼다.
        /// 토스트 같은 UI 문구와 피격 정지(hitstop)는 호출하는 쪽이 같은 이벤트를 보고 처리한다.
        /// </summary>
        public void PlayEvents(Sim sim)
        {
            EnsureInit();
            if (sim == null) return;
            bool sound = !Quiet;
            Player p = sim.Player;
            var events = sim.Events;
            for (int i = 0; i < events.Count; i++)
            {
                SimEvent ev = events[i];
                switch (ev.Type)
                {
                    case EventType.Hit:
                        fx.Burst(ev.X, ev.Y, WhiteColor, 2, 140f, 2.5f, 0.2f);
                        if (sound)
                        {
                            bool big = ev.Value >= 30;
                            fx.AddText(ev.X, ev.Y, ArenaFloatTexts.Number(Mathf.RoundToInt((float)ev.Value)),
                                big ? new Color32(255, 210, 122, 255) : WhiteColor, big ? 17f : 13f);
                            audio.Play(Sfx.Hit);
                        }

                        break;

                    case EventType.Kill:
                    {
                        bool boss = ev.Kind == Kind.Boss;
                        float r = (float)ev.Value;
                        fx.Burst(ev.X, ev.Y, KindColors[ev.Kind], boss ? 160f : 7f + r / 2f, boss ? 620f : 240f,
                            boss ? 7f : 4f, boss ? 1.2f : 0.45f);
                        if (ev.Flag)
                        {
                            fx.Burst(ev.X, ev.Y, Gold, 60f, 420f, 5f, 0.8f);
                            fx.AddRing(ev.X, ev.Y, 200f, Gold, 0.6f);
                        }

                        if (boss)
                        {
                            fx.AddRing(ev.X, ev.Y, 520f, new Color32(255, 79, 216, 255), 0.9f);
                            fx.Flash = 1f;
                        }

                        if (sound)
                        {
                            fx.AddShake(boss ? 18f : ev.Kind == Kind.Tank ? 5f : 1.6f);
                            audio.Play(Sfx.Kill);
                        }

                        break;
                    }

                    case EventType.Shoot:
                        if (sound) audio.Play(Sfx.Shoot);
                        break;

                    case EventType.EnemyShoot:
                        if (sound) audio.Play(Sfx.EnemyShoot);
                        break;

                    case EventType.Nova:
                        fx.AddRing(ev.X, ev.Y, (float)ev.Value,
                            ev.Flag ? new Color32(125, 255, 168, 255) : new Color32(199, 155, 255, 255));
                        if (sound)
                        {
                            fx.AddShake(3f);
                            audio.Play(Sfx.Nova);
                        }

                        break;

                    case EventType.Chain:
                        fx.AddBolt(ev.Points);
                        if (sound) audio.Play(Sfx.Chain);
                        break;

                    case EventType.Blast:
                    {
                        Color32 ring = ev.Flag ? new Color32(255, 107, 61, 255) : Gold;
                        Color32 spark = ev.Flag ? new Color32(255, 107, 61, 255) : new Color32(255, 224, 102, 255);
                        fx.AddRing(ev.X, ev.Y, (float)ev.Value, ring, 0.3f);
                        fx.Burst(ev.X, ev.Y, spark, ev.Flag ? 26f : 8f, ev.Flag ? 360f : 220f, 4f, 0.4f);
                        if (sound)
                        {
                            fx.AddShake(ev.Flag ? 6f : 1.2f);
                            audio.Play(Sfx.Blast);
                        }

                        break;
                    }

                    case EventType.Chest:
                        fx.AddRing(p.X, p.Y, 220f, Gold, 0.6f);
                        fx.Burst(p.X, p.Y, Gold, 40f, 320f, 4f, 0.7f);
                        if (sound) audio.Play(Sfx.Chest);
                        break;

                    case EventType.Evolve:
                    {
                        Color32 c = UpgradeColors[Mathf.Clamp(ev.Kind, 0, UpgradeColors.Length - 1)];
                        fx.AddRing(p.X, p.Y, 420f, c, 0.9f);
                        fx.Burst(p.X, p.Y, c, 120f, 520f, 5f, 1f);
                        if (sound)
                        {
                            fx.Flash = 0.7f;
                            audio.Play(Sfx.Evolve);
                        }

                        break;
                    }

                    case EventType.Elite:
                        if (sound) audio.Play(Sfx.Warn);
                        break;

                    case EventType.Charge:
                        if (sound) audio.Warning(false);
                        break;

                    case EventType.Fuse:
                        if (sound) audio.Warning(true);
                        break;

                    case EventType.Combo:
                        if (sound) fx.AddText(p.X, p.Y - 30, ArenaFloatTexts.Combo(ev.Kind), Gold, 20f);
                        break;

                    case EventType.Gem:
                        if (sound) audio.Play(Sfx.Gem);
                        break;

                    case EventType.Dash:
                        fx.Burst(p.X, p.Y, new Color32(127, 227, 255, 255), 14f, 200f, 4f, 0.35f);
                        if (sound) audio.Play(Sfx.Dash);
                        break;

                    case EventType.PlayerHit:
                        fx.Burst(p.X, p.Y, KindColors[0], 18f, 300f, 4f, 0.5f);
                        if (sound)
                        {
                            fx.AddShake(12f);
                            fx.Hurt = 1f;
                            fx.AddText(p.X, p.Y - 16, ArenaFloatTexts.Negative(Mathf.RoundToInt((float)ev.Value)),
                                KindColors[0], 18f);
                            audio.Play(Sfx.Hurt);
                        }

                        break;

                    case EventType.LevelUp:
                        fx.AddRing(p.X, p.Y, 160f, new Color32(93, 242, 192, 255), 0.5f);
                        if (sound) audio.Play(Sfx.LevelUp);
                        break;

                    case EventType.BossSpawn:
                        if (sound) audio.Play(Sfx.Warn);
                        break;

                    case EventType.Win:
                        if (sound) audio.Play(Sfx.Win);
                        break;

                    case EventType.Dead:
                        fx.Burst(p.X, p.Y, new Color32(255, 179, 71, 255), 90f, 460f, 6f, 1f);
                        if (sound)
                        {
                            fx.AddShake(16f);
                            audio.Play(Sfx.Lose);
                        }

                        break;
                }
            }
        }
    }
}
