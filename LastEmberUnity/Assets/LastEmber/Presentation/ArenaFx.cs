using UnityEngine;

namespace LastEmber.UnityClient
{
    /// <summary>
    /// 연출 전용 이펙트(파티클, 데미지 숫자, 링, 번개, 화면 흔들림). client/src/fx.ts의 포팅.
    /// 시뮬레이션 결과에 영향을 주지 않으므로 UnityEngine.Random과 실제 프레임 시간을 쓴다.
    /// 모든 저장소는 미리 만든 배열이라 플레이 중 가비지가 생기지 않는다.
    /// </summary>
    internal sealed class ArenaFx
    {
        public struct Particle
        {
            public float X, Y, Vx, Vy, Life, Max, Size;
            public Color32 Color;
        }

        public struct FloatText
        {
            public float X, Y, Life, Size;
            public string Text;
            public Color32 Color;
        }

        public struct Ring
        {
            public float X, Y, R, Life, Max;
            public Color32 Color;
        }

        public struct Bolt
        {
            public float[] Points; // x0, y0, x1, y1, ...
            public int Count;      // 사용 중인 float 수
            public float Life;
        }

        public const int MaxParticles = 700;
        public const int MaxTexts = 48;
        public const int MaxRings = 64;
        public const int MaxBolts = 16;
        public const int MaxBoltFloats = 64;

        public readonly Particle[] Particles = new Particle[MaxParticles];
        public int ParticleCount;
        public readonly FloatText[] Texts = new FloatText[MaxTexts];
        public int TextCount;
        public readonly Ring[] Rings = new Ring[MaxRings];
        public int RingCount;
        public readonly Bolt[] Bolts = new Bolt[MaxBolts];
        public int BoltCount;

        public float Shake;
        public float Hurt;  // 피격 시 붉은 화면 테두리 (1 → 0)
        public float Flash; // 화면 전체 섬광

        public ArenaFx()
        {
            for (int i = 0; i < MaxBolts; i++) Bolts[i].Points = new float[MaxBoltFloats];
        }

        public void Clear()
        {
            ParticleCount = 0;
            TextCount = 0;
            RingCount = 0;
            BoltCount = 0;
            Shake = 0;
            Hurt = 0;
            Flash = 0;
        }

        public void Burst(double x, double y, Color32 color, float count, float speed, float size = 3f, float life = 0.45f)
        {
            int n = Mathf.CeilToInt(count);
            for (int i = 0; i < n; i++)
            {
                if (ParticleCount >= MaxParticles) return;
                float a = Random.value * Mathf.PI * 2f;
                float v = speed * (0.3f + Random.value * 0.7f);
                ref Particle p = ref Particles[ParticleCount++];
                p.X = (float)x;
                p.Y = (float)y;
                p.Vx = Mathf.Cos(a) * v;
                p.Vy = Mathf.Sin(a) * v;
                p.Max = p.Life = life * (0.6f + Random.value * 0.6f);
                p.Size = size * (0.6f + Random.value * 0.8f);
                p.Color = color;
            }
        }

        public void AddText(double x, double y, string text, Color32 color, float size = 14f)
        {
            if (TextCount >= MaxTexts)
            {
                for (int i = 1; i < TextCount; i++) Texts[i - 1] = Texts[i];
                TextCount--;
            }

            ref FloatText t = ref Texts[TextCount++];
            t.X = (float)x + (Random.value - 0.5f) * 14f;
            t.Y = (float)y - 8f;
            t.Life = 0.6f;
            t.Text = text;
            t.Color = color;
            t.Size = size;
        }

        public void AddRing(double x, double y, float r, Color32 color, float life = 0.35f)
        {
            if (RingCount >= MaxRings) return;
            ref Ring g = ref Rings[RingCount++];
            g.X = (float)x;
            g.Y = (float)y;
            g.R = r;
            g.Life = life;
            g.Max = life;
            g.Color = color;
        }

        public void AddBolt(double[] points)
        {
            if (BoltCount >= MaxBolts || points == null) return;
            ref Bolt b = ref Bolts[BoltCount++];
            int n = Mathf.Min(points.Length, MaxBoltFloats) & ~1;
            for (int i = 0; i < n; i++) b.Points[i] = (float)points[i];
            b.Count = n;
            b.Life = 0.14f;
        }

        public void AddShake(float amount)
        {
            Shake = Mathf.Min(18f, Shake + amount);
        }

        public void Update(float dt)
        {
            int w = 0;
            for (int i = 0; i < ParticleCount; i++)
            {
                Particle p = Particles[i];
                p.Life -= dt;
                if (p.Life <= 0f) continue;
                p.X += p.Vx * dt;
                p.Y += p.Vy * dt;
                p.Vx *= 0.94f;
                p.Vy *= 0.94f;
                Particles[w++] = p;
            }
            ParticleCount = w;

            w = 0;
            for (int i = 0; i < TextCount; i++)
            {
                FloatText t = Texts[i];
                t.Life -= dt;
                t.Y -= 46f * dt;
                if (t.Life > 0f) Texts[w++] = t;
            }
            TextCount = w;

            w = 0;
            for (int i = 0; i < RingCount; i++)
            {
                Ring r = Rings[i];
                r.Life -= dt;
                if (r.Life > 0f) Rings[w++] = r;
            }
            RingCount = w;
            // 번개는 배열을 들고 있으므로 구조체를 통째로 맞바꿔 배열 소유권도 같이 옮긴다.
            w = 0;
            for (int i = 0; i < BoltCount; i++)
            {
                Bolt b = Bolts[i];
                b.Life -= dt;
                Bolts[i] = b;
                if (b.Life <= 0f) continue;
                if (w != i)
                {
                    Bolt tmp = Bolts[w];
                    Bolts[w] = Bolts[i];
                    Bolts[i] = tmp;
                }
                w++;
            }
            BoltCount = w;

            Shake *= Mathf.Pow(0.0015f, dt);
            if (Shake < 0.05f) Shake = 0f;
            Hurt = Mathf.Max(0f, Hurt - dt * 2.2f);
            Flash = Mathf.Max(0f, Flash - dt * 3f);
        }
    }
}
