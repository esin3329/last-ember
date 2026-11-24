// 결정론적 게임 시뮬레이션 코어 — shared/sim.ts의 C# 포팅.
//
// UnityEngine을 전혀 참조하지 않는 순수 C#이라 Unity, 서버, 테스트 어디서든 같은 코드가 돈다.
// TypeScript 버전과 비트 단위로 같은 결과를 내기 위해 다음을 지킨다.
//
//  1. double만 쓰고(JS의 number와 같은 IEEE 754 배정밀도), 연산은 + - * / Math.Sqrt만 쓴다.
//  2. 식의 계산 순서를 TS와 똑같이 둔다. 부동소수는 결합 순서가 바뀌면 결과가 달라진다.
//  3. 난수 호출 순서, 엔티티 순회 순서를 똑같이 둔다.
//  4. 정수 연산은 JS의 32비트 의미(넘치면 잘림)에 맞춰 unchecked로 처리한다.
//
// 이 규칙이 실제로 지켜지는지는 LastEmber.Verify가 TS에서 만든 리플레이로 확인한다.

using System;
using System.Collections.Generic;

namespace LastEmber.Core
{
    public enum Phase { Playing, LevelUp, Dead, Won }

    public sealed class Enemy
    {
        public int Id, Kind;
        public double X, Y, Px, Py; // Px, Py: 이전 틱 위치 (렌더 보간용)
        public double Kx, Ky;       // 넉백 속도
        public double Hp, MaxHp, R, Speed, Dmg;
        public int Cd, Cd2, Flash, OrbitCd, Mark;
        public bool Elite;
        public int Stun;          // 마비 남은 틱
        public int Mode, Timer;   // 행동 상태 (자폭병: 1=점화, 보스: 1=조준 2=돌진)
        public double Ax, Ay;     // 보스 돌진 방향
        public bool Dead;
    }

    public sealed class Chest
    {
        public double X, Y;
    }

    public struct Blast
    {
        public double X, Y, R, Dmg;
        public bool HurtsPlayer;
    }

    public sealed class Bullet
    {
        public double X, Y, Px, Py, Vx, Vy, Dmg;
        public int Life, Pierce, LastHit;
        public bool Hostile;
    }

    public sealed class Gem
    {
        public double X, Y, Px, Py;
        public int Value;
        public bool Pulled;
    }

    public sealed class Player
    {
        public double X, Y, Px, Py;
        public double Fx, Fy; // 바라보는 방향
        public double Hp, MaxHp;
        public int DashT, DashCd;
        public double DashDx, DashDy;
        public int Iframes, Level, Xp, XpNext;
    }

    public enum EventType
    {
        Hit, Kill, Shoot, EnemyShoot, Nova, Chain, Blast, Gem, Chest, Dash, PlayerHit, Combo, LevelUp, Evolve,
        Elite, Charge, BossSpawn, Wave, Win, Dead, Fuse,
    }

    /// <summary>연출용 이벤트. 렌더러(Unity라면 MonoBehaviour)가 받아서 파티클·사운드를 재생한다.</summary>
    public struct SimEvent
    {
        public EventType Type;
        public double X, Y, Value; // Value: 피해량(Hit, PlayerHit) 또는 반지름(Nova, Kill, Blast)
        public int Kind;           // Kill: 적 종류, Evolve: 업그레이드, Combo: 단계, PlayerHit: 끊긴 콤보
        public bool Flag;          // Kill: 엘리트, Nova/Chain: 진화, Blast: 플레이어에게 피해
        public double[] Points;    // Chain: x0, y0, x1, y1, ...
    }

    public sealed class Sim
    {
        const double Cell = 64;
        const int GW = 38; // ceil(2400 / 64)
        const int MaxEnemies = 320;
        const int SoftCap = 290;
        const double MaxR = 44;
        const int MaxGems = 350;
        const double Diag = 0.7071067811865476;

        // 상수 회전 (cos, sin). 초월함수를 런타임에 부르지 않기 위해 리터럴로 둔다.
        const double RotOrbitC = 0.9975640502598242, RotOrbitS = 0.0697564737441253; // 4도/틱
        const double Rot22C = 0.9238795325112867, Rot22S = 0.3826834323650898;       // 22.5도
        const double Rot11C = 0.9807852804032304, Rot11S = 0.19509032201612825;      // 11.25도
        const double Rot120C = -0.5, Rot120S = 0.8660254037844386;
        const double Rot60C = 0.5, Rot60S = 0.8660254037844386;

        public readonly Rng Rng;
        public int Tick;        // 시뮬레이션 틱. 월드가 실제로 진행될 때만 오른다.
        public int Frame;       // Step() 호출 수(입력 프레임). 레벨업 선택 프레임은 Frame만 올리고 Tick은 올리지 않는다.
        public readonly int SegmentFrames; // 0이면 구간 전환 없음(v2)
        public int Segment;     // 진행 중인 구간 번호(0부터)

        /// <summary>다음 Step() 전에 새 구간 시드가 필요한가. 판이 끝났으면 false.</summary>
        public bool SegmentDue =>
            SegmentFrames > 0 && Phase != Phase.Dead && Phase != Phase.Won && Frame >= (Segment + 1) * SegmentFrames;

        /// <summary>구간 시드로 RNG를 다시 맞춘다.</summary>
        public void BeginSegment(int seed)
        {
            if (!SegmentDue) throw new InvalidOperationException("segment seed is not due");
            Rng.S = seed;
            Segment++;
        }
        public Phase Phase = Phase.Playing;
        public readonly Player Player;
        public readonly int[] Levels = new int[Defs.UpgradeCount];
        public readonly List<int> Choices = new List<int>();
        public int PendingLevels;
        public readonly List<Enemy> Enemies = new List<Enemy>();
        public readonly List<Bullet> Bullets = new List<Bullet>();
        public readonly List<Gem> Gems = new List<Gem>();
        public readonly List<Chest> Chests = new List<Chest>();
        public double OrbX = 1, OrbY = 0; // 공전 칼날 기준 방향 벡터
        public bool BossSpawned;
        public int BossId = -1;
        public int Kills, Score;
        public int Combo, BestCombo; // 마지막 피격 이후 처치 수

        /// <summary>false면 이벤트를 만들지 않는다(서버 검증처럼 연출이 필요 없을 때).</summary>
        public readonly bool Emit;
        public readonly List<SimEvent> Events = new List<SimEvent>();

        int boltCd = 20, novaCd = 60, chainCd = 40;
        double spawnAcc;
        int nextId = 1, markSeq;
        double dmgMul = 1, cdMul = 1, speedMul = 1, magnet = 90, regen;
        double tmpX, tmpY;

        // 공간 분할 그리드 (연결 리스트 방식, 할당 없음)
        readonly int[] gridHead = new int[GW * GW];
        readonly int[] gridNext = new int[MaxEnemies];
        readonly int[] scratch = new int[MaxEnemies];
        readonly int[] scratch2 = new int[MaxEnemies];
        readonly List<int> pool = new List<int>();
        readonly List<Blast> blasts = new List<Blast>();

        /// <summary>
        /// segmentFrames &gt; 0이면 v3 규칙이다. Step()을 segmentFrames번 부를 때마다 BeginSegment()로 새 시드를 넣어야 한다.
        /// </summary>
        public Sim(int seed, bool emit = true, int segmentFrames = 0)
        {
            Rng = new Rng(seed);
            SegmentFrames = segmentFrames;
            Emit = emit;
            Levels[Up.Bolt] = 1;
            Player = new Player
            {
                X = Defs.Arena / 2, Y = Defs.Arena / 2, Px = Defs.Arena / 2, Py = Defs.Arena / 2,
                Fx = 1, Fy = 0,
                Hp = Defs.PlayerHp, MaxHp = Defs.PlayerHp,
                DashDx = 1, DashDy = 0,
                Level = 1, Xp = 0, XpNext = XpForLevel(1),
            };
            RecomputeStats();
        }

        public static int XpForLevel(int level)
        {
            return 4 + level * 3 + ((level * level) >> 2);
        }

        void RecomputeStats()
        {
            dmgMul = 1 + 0.12 * Levels[Up.Might];
            cdMul = 1 - 0.08 * Levels[Up.Haste];
            speedMul = 1 + 0.08 * Levels[Up.Swift];
            magnet = 90 * (1 + 0.35 * Levels[Up.Magnet]);
            regen = 0.6 * Levels[Up.Regen];
        }

        int CdTicks(double baseTicks)
        {
            return (int)Math.Floor(baseTicks * cdMul + 0.5);
        }

        static double Clamp(double v, double lo, double hi)
        {
            return v < lo ? lo : v > hi ? hi : v;
        }

        // ───────────────────────── 한 틱 진행 ─────────────────────────

        public void Step(InputFrame inp)
        {
            Events.Clear();
            if (Phase == Phase.Dead || Phase == Phase.Won) return;
            if (SegmentDue) throw new InvalidOperationException("segment seed required: call BeginSegment() before Step()");
            Frame++;

            // 레벨업 선택 중에는 월드가 멈추고, 선택 입력만 소비한다.
            if (Phase == Phase.LevelUp)
            {
                if (inp.Choice >= 0 && inp.Choice < Choices.Count)
                {
                    ApplyUpgrade(Choices[inp.Choice]);
                    PendingLevels--;
                    if (PendingLevels > 0) RollChoices();
                    else Phase = Phase.Playing;
                }
                return;
            }

            Tick++;
            UpdatePlayer(inp);
            SpawnDirector();
            UpdateEnemies();
            BuildGrid();
            SeparateEnemies();
            BuildGrid();
            TouchPlayer();
            FireWeapons();
            UpdateBullets();
            ResolveBlasts();
            UpdateGems();
            RemoveDead();

            Player p = Player;
            if (Phase == Phase.Won)
            {
                Score += (int)Math.Floor(p.Hp) * 20;
                if (Emit) Events.Add(new SimEvent { Type = EventType.Win });
            }
            else if (p.Hp <= 0 || Tick >= Defs.MaxTicks)
            {
                p.Hp = 0;
                Phase = Phase.Dead;
                if (Emit) Events.Add(new SimEvent { Type = EventType.Dead });
            }
            else if (PendingLevels > 0)
            {
                RollChoices();
            }
        }

        // ───────────────────────── 플레이어 ─────────────────────────

        void UpdatePlayer(InputFrame inp)
        {
            Player p = Player;
            p.Px = p.X;
            p.Py = p.Y;
            double dx = inp.Mx;
            double dy = inp.My;
            if (dx != 0 && dy != 0)
            {
                dx *= Diag;
                dy *= Diag;
            }
            if (dx != 0 || dy != 0)
            {
                p.Fx = dx;
                p.Fy = dy;
            }
            if (p.DashCd > 0) p.DashCd--;
            if (p.Iframes > 0) p.Iframes--;
            if (inp.Dash && p.DashCd == 0 && p.DashT == 0)
            {
                p.DashT = Defs.DashTicks;
                p.DashCd = Defs.DashCd;
                p.DashDx = p.Fx;
                p.DashDy = p.Fy;
                if (Emit) Events.Add(new SimEvent { Type = EventType.Dash });
            }
            double vx, vy;
            if (p.DashT > 0)
            {
                p.DashT--;
                vx = p.DashDx * Defs.DashSpeed;
                vy = p.DashDy * Defs.DashSpeed;
            }
            else
            {
                double sp = Defs.PlayerSpeed * speedMul;
                vx = dx * sp;
                vy = dy * sp;
            }
            p.X = Clamp(p.X + vx * Defs.DT, Defs.PlayerR, Defs.Arena - Defs.PlayerR);
            p.Y = Clamp(p.Y + vy * Defs.DT, Defs.PlayerR, Defs.Arena - Defs.PlayerR);
            if (regen > 0 && p.Hp < p.MaxHp)
            {
                p.Hp = Math.Min(p.MaxHp, p.Hp + regen * Defs.DT);
            }
        }

        void HurtPlayer(double dmg)
        {
            Player.Hp -= dmg;
            Player.Iframes = Defs.HitIframes;
            if (Emit) Events.Add(new SimEvent { Type = EventType.PlayerHit, Value = dmg, Kind = Combo });
            Combo = 0;
        }

        // ───────────────────────── 스폰 ─────────────────────────

        /// <summary>단위원 안에서 기각 샘플링 후 정규화 → 삼각함수 없이 균등한 무작위 방향.</summary>
        void RandDir()
        {
            for (;;)
            {
                double x = Rng.NextFloat() * 2 - 1;
                double y = Rng.NextFloat() * 2 - 1;
                double d = x * x + y * y;
                if (d > 0.01 && d <= 1)
                {
                    double l = Math.Sqrt(d);
                    tmpX = x / l;
                    tmpY = y / l;
                    return;
                }
            }
        }

        Enemy SpawnEnemy(int kind, double x, double y, int cap)
        {
            if (Enemies.Count >= cap) return null;
            EnemyDef def = Defs.Enemies[kind];
            double scale = kind == Kind.Boss ? 1 : 1 + (Tick * Defs.DT) / 100;
            double hp = def.Hp * scale;
            x = Clamp(x, def.R, Defs.Arena - def.R);
            y = Clamp(y, def.R, Defs.Arena - def.R);
            var e = new Enemy
            {
                Id = nextId++, Kind = kind, X = x, Y = y, Px = x, Py = y,
                Hp = hp, MaxHp = hp, R = def.R, Speed = def.Speed, Dmg = def.Dmg,
                Cd = 90, Cd2 = 300,
            };
            Enemies.Add(e);
            return e;
        }

        Enemy SpawnAtRing(int kind, int cap)
        {
            Player p = Player;
            RandDir();
            double dist = 720 + Rng.NextFloat() * 120;
            double x = p.X + tmpX * dist;
            double y = p.Y + tmpY * dist;
            // 벽에 막혀 화면 안에 나타나게 되면 반대편으로 보낸다.
            if (x < 0 || x > Defs.Arena) x = p.X - tmpX * dist;
            if (y < 0 || y > Defs.Arena) y = p.Y - tmpY * dist;
            return SpawnEnemy(kind, x, y, cap);
        }

        int PickKind(double sec)
        {
            double roll = Rng.NextFloat();
            double tank = sec > 80 ? 0.1 : 0;
            double shooter = sec > 45 ? 0.14 : 0;
            double bomber = sec > 60 ? 0.08 : 0;
            double runner = sec > 15 ? 0.26 : 0;
            if (roll < tank) return Kind.Tank;
            if (roll < tank + shooter) return Kind.Shooter;
            if (roll < tank + shooter + bomber) return Kind.Bomber;
            if (roll < tank + shooter + bomber + runner) return Kind.Runner;
            return Kind.Chaser;
        }

        void SpawnDirector()
        {
            double sec = Tick * Defs.DT;
            if (!BossSpawned && Tick >= Defs.BossTick)
            {
                BossSpawned = true;
                Enemy boss = SpawnAtRing(Kind.Boss, MaxEnemies);
                if (boss != null)
                {
                    BossId = boss.Id;
                    boss.Cd = 120;
                    boss.Timer = Defs.ChargeCd;
                }
                if (Emit) Events.Add(new SimEvent { Type = EventType.BossSpawn });
            }

            double rate = BossSpawned ? 2.5 : 1.1 + sec * 0.052;
            spawnAcc += rate * Defs.DT;
            while (spawnAcc >= 1)
            {
                spawnAcc -= 1;
                SpawnAtRing(PickKind(sec), SoftCap);
            }

            // 30초마다 포위 웨이브: 플레이어를 둘러싼 원형으로 16마리.
            if (!BossSpawned && Tick % (30 * 60) == 0)
            {
                Player p = Player;
                RandDir();
                double dx = tmpX;
                double dy = tmpY;
                for (int i = 0; i < 16; i++)
                {
                    SpawnEnemy((i & 1) == 0 ? Kind.Chaser : Kind.Runner, p.X + dx * 560, p.Y + dy * 560, SoftCap);
                    double nx = dx * Rot22C - dy * Rot22S;
                    dy = dx * Rot22S + dy * Rot22C;
                    dx = nx;
                }
                if (Emit) Events.Add(new SimEvent { Type = EventType.Wave });
            }

            // 45초마다 엘리트. 보스전에는 나오지 않는다.
            if (!BossSpawned && Tick % Defs.EliteEvery == 0)
            {
                Enemy e = SpawnAtRing(Kind.Tank, MaxEnemies - 1);
                if (e != null)
                {
                    e.Elite = true;
                    e.Hp *= Defs.EliteHpMul;
                    e.MaxHp = e.Hp;
                    e.R *= Defs.EliteRMul;
                    e.Speed *= Defs.EliteSpeedMul;
                    e.Dmg *= Defs.EliteDmgMul;
                    if (Emit) Events.Add(new SimEvent { Type = EventType.Elite });
                }
            }
        }

        // ───────────────────────── 적 ─────────────────────────

        void HostileBullet(double x, double y, double dx, double dy, double speed, double dmg)
        {
            Bullets.Add(new Bullet
            {
                X = x, Y = y, Px = x, Py = y, Vx = dx * speed, Vy = dy * speed,
                Dmg = dmg, Life = 240, Pierce = 0, LastHit = -1, Hostile = true,
            });
        }

        void UpdateEnemies()
        {
            Player p = Player;
            int n = Enemies.Count; // 루프 중 소환된 적은 다음 틱부터 움직인다.
            for (int i = 0; i < n; i++)
            {
                Enemy e = Enemies[i];
                e.Px = e.X;
                e.Py = e.Y;
                if (e.Flash > 0) e.Flash--;
                if (e.OrbitCd > 0) e.OrbitCd--;

                // 마비: 넉백만 받고 아무 행동도 하지 않는다 (자폭 도화선도 멈춘다).
                if (e.Stun > 0)
                {
                    e.Stun--;
                    e.X = Clamp(e.X + e.Kx * Defs.DT, e.R, Defs.Arena - e.R);
                    e.Y = Clamp(e.Y + e.Ky * Defs.DT, e.R, Defs.Arena - e.R);
                    e.Kx *= 0.86;
                    e.Ky *= 0.86;
                    continue;
                }

                double dx = p.X - e.X;
                double dy = p.Y - e.Y;
                double d = Math.Sqrt(dx * dx + dy * dy);
                if (d == 0) d = 1;
                dx /= d;
                dy /= d;
                double mx = dx;
                double my = dy;

                if (e.Kind == Kind.Shooter)
                {
                    // 거리를 유지하며 옆으로 돌면서 사격
                    if (d < 220)
                    {
                        mx = -dx;
                        my = -dy;
                    }
                    else if (d < 330)
                    {
                        double side = (e.Id & 1) == 0 ? 1 : -1;
                        mx = -dy * side;
                        my = dx * side;
                    }
                    if (--e.Cd <= 0 && d < 560)
                    {
                        e.Cd = 130;
                        HostileBullet(e.X, e.Y, dx, dy, 210, e.Dmg);
                        if (Emit) Events.Add(new SimEvent { Type = EventType.EnemyShoot, X = e.X, Y = e.Y });
                    }
                }
                else if (e.Kind == Kind.Bomber)
                {
                    if (e.Mode == 0 && d < Defs.BomberTrigger)
                    {
                        e.Mode = 1;
                        e.Timer = Defs.BomberFuse;
                        if (Emit) Events.Add(new SimEvent { Type = EventType.Fuse });
                    }
                    if (e.Mode == 1)
                    {
                        // 점화 중에는 거의 멈춰서 폭발 범위를 보여 준다.
                        mx *= 0.15;
                        my *= 0.15;
                        if (--e.Timer <= 0)
                        {
                            e.Dead = true; // 자폭은 처치로 치지 않는다 (점수·경험치 없음)
                            blasts.Add(new Blast { X = e.X, Y = e.Y, R = Defs.BomberRadius, Dmg = Defs.BomberDmgEnemy, HurtsPlayer = true });
                            continue;
                        }
                    }
                }
                else if (e.Kind == Kind.Boss)
                {
                    bool enraged = e.Hp < e.MaxHp * 0.5;
                    if (--e.Cd <= 0)
                    {
                        e.Cd = enraged ? 95 : 150;
                        // 16방향 탄막. 발사할 때마다 11.25도씩 어긋나게 해서 틈이 바뀐다.
                        double bx = dx;
                        double by = dy;
                        if ((e.Cd2 & 1) == 0)
                        {
                            double nx = bx * Rot11C - by * Rot11S;
                            by = bx * Rot11S + by * Rot11C;
                            bx = nx;
                        }
                        for (int k = 0; k < 16; k++)
                        {
                            HostileBullet(e.X, e.Y, bx, by, enraged ? 230 : 190, 14);
                            double nx = bx * Rot22C - by * Rot22S;
                            by = bx * Rot22S + by * Rot22C;
                            bx = nx;
                        }
                        if (Emit) Events.Add(new SimEvent { Type = EventType.EnemyShoot, X = e.X, Y = e.Y });
                    }
                    if (--e.Cd2 <= 0)
                    {
                        e.Cd2 = 360;
                        for (int k = 0; k < 5; k++)
                        {
                            RandDir();
                            SpawnEnemy(Kind.Runner, e.X + tmpX * 70, e.Y + tmpY * 70, MaxEnemies - 1);
                        }
                    }
                    if (enraged)
                    {
                        mx *= 1.35;
                        my *= 1.35;
                        // 2페이즈: 대기 → 조준(예고) → 돌진
                        if (e.Mode == 0)
                        {
                            if (--e.Timer <= 0)
                            {
                                e.Mode = 1;
                                e.Timer = Defs.ChargeWindup;
                                e.Ax = dx;
                                e.Ay = dy;
                                if (Emit) Events.Add(new SimEvent { Type = EventType.Charge });
                            }
                        }
                        else if (e.Mode == 1)
                        {
                            mx = 0;
                            my = 0;
                            if (e.Timer > Defs.ChargeLock)
                            {
                                e.Ax = dx;
                                e.Ay = dy;
                            }
                            if (--e.Timer <= 0)
                            {
                                e.Mode = 2;
                                e.Timer = Defs.ChargeDash;
                            }
                        }
                        else
                        {
                            mx = (e.Ax * Defs.ChargeSpeed) / e.Speed;
                            my = (e.Ay * Defs.ChargeSpeed) / e.Speed;
                            if (--e.Timer <= 0)
                            {
                                e.Mode = 0;
                                e.Timer = Defs.ChargeCd;
                            }
                        }
                    }
                }

                e.X = Clamp(e.X + (mx * e.Speed + e.Kx) * Defs.DT, e.R, Defs.Arena - e.R);
                e.Y = Clamp(e.Y + (my * e.Speed + e.Ky) * Defs.DT, e.R, Defs.Arena - e.R);
                e.Kx *= 0.86;
                e.Ky *= 0.86;
            }
        }

        static int CellCoord(double v)
        {
            int c = (int)(v / Cell); // 0 방향으로 버림 — JS의 (v / CELL) | 0 과 같다
            return c < 0 ? 0 : c >= GW ? GW - 1 : c;
        }

        void BuildGrid()
        {
            for (int i = 0; i < gridHead.Length; i++) gridHead[i] = -1;
            for (int i = 0; i < Enemies.Count; i++)
            {
                int c = CellCoord(Enemies[i].Y) * GW + CellCoord(Enemies[i].X);
                gridNext[i] = gridHead[c];
                gridHead[c] = i;
            }
        }

        /// <summary>원과 겹치는 살아 있는 적의 인덱스를 scratch에 담고 개수를 반환.</summary>
        int Query(double x, double y, double r)
        {
            double R = r + MaxR;
            int x0 = CellCoord(x - R);
            int x1 = CellCoord(x + R);
            int y0 = CellCoord(y - R);
            int y1 = CellCoord(y + R);
            int n = 0;
            for (int cy = y0; cy <= y1; cy++)
            {
                for (int cx = x0; cx <= x1; cx++)
                {
                    for (int i = gridHead[cy * GW + cx]; i != -1; i = gridNext[i])
                    {
                        Enemy e = Enemies[i];
                        if (e.Dead) continue;
                        double dx = e.X - x;
                        double dy = e.Y - y;
                        double rr = r + e.R;
                        if (dx * dx + dy * dy < rr * rr) scratch[n++] = i;
                    }
                }
            }
            return n;
        }

        static void PushApart(Enemy a, Enemy b)
        {
            double dx = b.X - a.X;
            double dy = b.Y - a.Y;
            double rr = a.R + b.R;
            double d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr || d2 == 0) return;
            double d = Math.Sqrt(d2);
            double push = ((rr - d) * 0.25) / d;
            if (a.Kind != Kind.Boss)
            {
                a.X -= dx * push;
                a.Y -= dy * push;
            }
            if (b.Kind != Kind.Boss)
            {
                b.X += dx * push;
                b.Y += dy * push;
            }
        }

        /// <summary>적끼리 겹치지 않게 민다. 같은 셀 + 절반 이웃(4칸)만 보면 모든 쌍을 한 번씩 처리한다.</summary>
        void SeparateEnemies()
        {
            List<Enemy> es = Enemies;
            for (int cy = 0; cy < GW; cy++)
            {
                for (int cx = 0; cx < GW; cx++)
                {
                    for (int i = gridHead[cy * GW + cx]; i != -1; i = gridNext[i])
                    {
                        Enemy a = es[i];
                        for (int j = gridNext[i]; j != -1; j = gridNext[j]) PushApart(a, es[j]);
                        if (cx + 1 < GW)
                        {
                            for (int j = gridHead[cy * GW + cx + 1]; j != -1; j = gridNext[j]) PushApart(a, es[j]);
                        }
                        if (cy + 1 < GW)
                        {
                            int row = (cy + 1) * GW;
                            if (cx > 0) for (int j = gridHead[row + cx - 1]; j != -1; j = gridNext[j]) PushApart(a, es[j]);
                            for (int j = gridHead[row + cx]; j != -1; j = gridNext[j]) PushApart(a, es[j]);
                            if (cx + 1 < GW) for (int j = gridHead[row + cx + 1]; j != -1; j = gridNext[j]) PushApart(a, es[j]);
                        }
                    }
                }
            }
            for (int i = 0; i < es.Count; i++)
            {
                Enemy e = es[i];
                e.X = Clamp(e.X, e.R, Defs.Arena - e.R);
                e.Y = Clamp(e.Y, e.R, Defs.Arena - e.R);
            }
        }

        void TouchPlayer()
        {
            Player p = Player;
            if (p.Iframes > 0 || p.DashT > 0) return;
            int n = Query(p.X, p.Y, Defs.PlayerR - 3);
            if (n == 0) return;
            double dmg = 0;
            for (int i = 0; i < n; i++)
            {
                Enemy e = Enemies[scratch[i]];
                if (e.Dmg > dmg) dmg = e.Dmg;
            }
            HurtPlayer(dmg);
        }

        void DamageEnemy(Enemy e, double dmg, double kx, double ky)
        {
            if (e.Dead) return;
            e.Hp -= dmg;
            e.Flash = 5;
            EnemyDef def = Defs.Enemies[e.Kind];
            double kb = def.Kb * (e.Elite ? Defs.EliteKbMul : 1);
            e.Kx += kx * kb;
            e.Ky += ky * kb;
            if (Emit) Events.Add(new SimEvent { Type = EventType.Hit, X = e.X, Y = e.Y, Value = dmg });
            if (e.Hp > 0) return;

            e.Dead = true;
            Kills++;
            // 콤보 배율: 정수 연산으로만 계산 (tier 0~4 → 1.0~3.0배)
            int tier = Defs.ComboTier(Combo);
            int baseScore = e.Elite ? Defs.EliteScore : def.Score;
            Score += (baseScore * (2 + tier)) / 2;
            Combo++;
            if (Combo > BestCombo) BestCombo = Combo;
            if (Emit && Defs.ComboTier(Combo) > tier) Events.Add(new SimEvent { Type = EventType.Combo, Kind = tier + 1 });

            if (def.Xp > 0) DropGem(e.X, e.Y, e.Elite ? def.Xp * Defs.EliteXpMul : def.Xp);
            if (e.Elite) Chests.Add(new Chest { X = e.X, Y = e.Y });
            // 먼저 잡은 자폭병은 적에게만 피해를 주는 폭발로 바뀐다 (연쇄 유도).
            if (e.Kind == Kind.Bomber)
            {
                blasts.Add(new Blast { X = e.X, Y = e.Y, R = Defs.BomberRadius, Dmg = Defs.BomberDmgEnemy * dmgMul, HurtsPlayer = false });
            }
            if (Emit) Events.Add(new SimEvent { Type = EventType.Kill, X = e.X, Y = e.Y, Kind = e.Kind, Value = e.R, Flag = e.Elite });
            if (e.Kind == Kind.Boss) Phase = Phase.Won;
        }

        /// <summary>쌓인 폭발을 순서대로 처리한다. 처리 중 새로 생긴 폭발(연쇄)도 같은 틱에 이어서 푼다.</summary>
        void ResolveBlasts()
        {
            Player p = Player;
            for (int i = 0; i < blasts.Count; i++)
            {
                Blast b = blasts[i];
                if (b.HurtsPlayer && p.Iframes == 0 && p.DashT == 0)
                {
                    double dx = p.X - b.X;
                    double dy = p.Y - b.Y;
                    double rr = b.R + Defs.PlayerR;
                    if (dx * dx + dy * dy < rr * rr) HurtPlayer(Defs.BomberDmgPlayer);
                }
                // DamageEnemy가 다시 폭발을 큐에 넣을 수 있으므로 쿼리 결과를 따로 복사해 둔다.
                int n = Query(b.X, b.Y, b.R);
                Array.Copy(scratch, scratch2, n);
                for (int k = 0; k < n; k++)
                {
                    Enemy e = Enemies[scratch2[k]];
                    double dx = e.X - b.X;
                    double dy = e.Y - b.Y;
                    double d = Math.Sqrt(dx * dx + dy * dy);
                    if (d == 0) d = 1;
                    DamageEnemy(e, e.Kind == Kind.Boss ? b.Dmg * Defs.BossBlastMul : b.Dmg, (dx / d) * 220, (dy / d) * 220);
                }
                if (Emit) Events.Add(new SimEvent { Type = EventType.Blast, X = b.X, Y = b.Y, Value = b.R, Flag = b.HurtsPlayer });
            }
            blasts.Clear();
        }

        void RemoveDead()
        {
            List<Enemy> es = Enemies;
            int w = 0;
            for (int i = 0; i < es.Count; i++)
            {
                if (!es[i].Dead) es[w++] = es[i];
            }
            es.RemoveRange(w, es.Count - w);
        }

        // ───────────────────────── 무기 ─────────────────────────

        Enemy NearestEnemy(double x, double y, double range, int skipMark)
        {
            Enemy best = null;
            double bestD = range * range;
            List<Enemy> es = Enemies;
            for (int i = 0; i < es.Count; i++)
            {
                Enemy e = es[i];
                if (e.Dead || e.Mark == skipMark) continue;
                double dx = e.X - x;
                double dy = e.Y - y;
                double d = dx * dx + dy * dy;
                if (d < bestD)
                {
                    bestD = d;
                    best = e;
                }
            }
            return best;
        }

        void PlayerBullet(double dx, double dy, double dmg, int pierce)
        {
            Player p = Player;
            double l = Math.Sqrt(dx * dx + dy * dy);
            Bullets.Add(new Bullet
            {
                X = p.X, Y = p.Y, Px = p.X, Py = p.Y,
                Vx = (dx / l) * Defs.BoltSpeed, Vy = (dy / l) * Defs.BoltSpeed,
                Dmg = dmg, Life = Defs.BoltLife, Pierce = pierce, LastHit = -1, Hostile = false,
            });
        }

        void FireWeapons()
        {
            Player p = Player;
            int[] L = Levels;

            // 불씨 탄환
            if (boltCd > 0) boltCd--;
            if (boltCd == 0)
            {
                Enemy target = NearestEnemy(p.X, p.Y, Defs.BoltRange, -1);
                if (target != null)
                {
                    int lv = L[Up.Bolt] - 1;
                    bool evo = L[Up.SunLance] > 0;
                    boltCd = CdTicks(Defs.BoltCd[lv]);
                    double dx = target.X - p.X;
                    double dy = target.Y - p.Y;
                    double d = Math.Sqrt(dx * dx + dy * dy);
                    if (d == 0) d = 1;
                    double ux = dx / d;
                    double uy = dy / d;
                    double dmg = Defs.BoltDmg[lv] * dmgMul * (evo ? Defs.SunLanceDmgMul : 1);
                    int count = Defs.BoltCount[lv];
                    int pierce = Defs.BoltPierce[lv] + (evo ? Defs.SunLancePierceAdd : 0);
                    // 부채꼴: 방향 벡터에 수직 성분을 더해서 만든다.
                    if (count == 1)
                    {
                        PlayerBullet(ux, uy, dmg, pierce);
                    }
                    else if (count == 2)
                    {
                        PlayerBullet(ux - uy * 0.1, uy + ux * 0.1, dmg, pierce);
                        PlayerBullet(ux + uy * 0.1, uy - ux * 0.1, dmg, pierce);
                    }
                    else
                    {
                        PlayerBullet(ux, uy, dmg, pierce);
                        PlayerBullet(ux - uy * 0.2, uy + ux * 0.2, dmg, pierce);
                        PlayerBullet(ux + uy * 0.2, uy - ux * 0.2, dmg, pierce);
                    }
                    if (Emit) Events.Add(new SimEvent { Type = EventType.Shoot });
                }
            }

            // 공전 칼날
            {
                double nx = OrbX * RotOrbitC - OrbY * RotOrbitS;
                double ny = OrbX * RotOrbitS + OrbY * RotOrbitC;
                double l = Math.Sqrt(nx * nx + ny * ny); // 누적 오차로 길이가 변하지 않게 재정규화
                OrbX = nx / l;
                OrbY = ny / l;
            }
            if (L[Up.Orbit] > 0)
            {
                int lv = L[Up.Orbit] - 1;
                bool evo = L[Up.Tempest] > 0;
                int blades = OrbitCount();
                double radius = OrbitRadiusNow();
                double dmg = Defs.OrbitDmg[lv] * dmgMul * (evo ? Defs.TempestDmgMul : 1);
                double erase2 = Defs.TempestEraseR * Defs.TempestEraseR;
                double bx = OrbX;
                double by = OrbY;
                for (int k = 0; k < blades; k++)
                {
                    double cx = p.X + bx * radius;
                    double cy = p.Y + by * radius;
                    int n = Query(cx, cy, Defs.OrbitBladeR);
                    for (int i = 0; i < n; i++)
                    {
                        Enemy e = Enemies[scratch[i]];
                        if (e.OrbitCd > 0) continue;
                        e.OrbitCd = Defs.OrbitHitCd;
                        DamageEnemy(e, dmg, bx * 160, by * 160);
                    }
                    if (evo)
                    {
                        // 칼날에 닿은 적 탄환은 다음 탄환 갱신에서 사라진다.
                        List<Bullet> bs = Bullets;
                        for (int j = 0; j < bs.Count; j++)
                        {
                            Bullet b = bs[j];
                            if (!b.Hostile) continue;
                            double ex = b.X - cx;
                            double ey = b.Y - cy;
                            if (ex * ex + ey * ey < erase2) b.Life = 1;
                        }
                    }
                    OrbitNext(ref bx, ref by, blades);
                }
            }

            // 섬광 파동
            if (L[Up.Nova] > 0)
            {
                if (novaCd > 0) novaCd--;
                if (novaCd == 0)
                {
                    int lv = L[Up.Nova] - 1;
                    bool evo = L[Up.Bloom] > 0;
                    novaCd = CdTicks(Defs.NovaCd[lv]);
                    double r = Defs.NovaRadius[lv] * (evo ? Defs.BloomRadiusMul : 1);
                    double dmg = Defs.NovaDmg[lv] * dmgMul;
                    int n = Query(p.X, p.Y, r);
                    for (int i = 0; i < n; i++)
                    {
                        Enemy e = Enemies[scratch[i]];
                        double dx = e.X - p.X;
                        double dy = e.Y - p.Y;
                        double d = Math.Sqrt(dx * dx + dy * dy);
                        if (d == 0) d = 1;
                        DamageEnemy(e, dmg, (dx / d) * Defs.NovaKb, (dy / d) * Defs.NovaKb);
                    }
                    if (evo && n > 0)
                    {
                        double heal = n * Defs.BloomHealPerHit;
                        p.Hp = Math.Min(p.MaxHp, p.Hp + (heal < Defs.BloomHealMax ? heal : Defs.BloomHealMax));
                    }
                    if (Emit) Events.Add(new SimEvent { Type = EventType.Nova, X = p.X, Y = p.Y, Value = r, Flag = evo });
                }
            }

            // 연쇄 번개
            if (L[Up.Chain] > 0)
            {
                if (chainCd > 0) chainCd--;
                if (chainCd == 0)
                {
                    int lv = L[Up.Chain] - 1;
                    bool evo = L[Up.Thunder] > 0;
                    int mark = ++markSeq;
                    Enemy cur = NearestEnemy(p.X, p.Y, Defs.ChainRange, mark);
                    if (cur != null)
                    {
                        chainCd = CdTicks(Defs.ChainCd[lv] * (evo ? Defs.ThunderCdMul : 1));
                        double dmg = Defs.ChainDmg[lv] * dmgMul * (evo ? Defs.ThunderDmgMul : 1);
                        List<double> pts = Emit ? new List<double> { p.X, p.Y } : null;
                        int hops = (evo ? Defs.ThunderJumps : Defs.ChainJumps[lv]) + 1;
                        while (cur != null && hops-- > 0)
                        {
                            cur.Mark = mark;
                            if (pts != null) { pts.Add(cur.X); pts.Add(cur.Y); }
                            double cx = cur.X;
                            double cy = cur.Y;
                            if (evo && cur.Kind != Kind.Boss) cur.Stun = Defs.ThunderStun;
                            DamageEnemy(cur, dmg, 0, 0);
                            cur = NearestEnemy(cx, cy, Defs.ChainJumpRange, mark);
                        }
                        if (pts != null) Events.Add(new SimEvent { Type = EventType.Chain, Points = pts.ToArray(), Flag = evo });
                    }
                }
            }
        }

        /// <summary>칼날 N개를 균등 배치하기 위한 다음 칼날 방향 (360/N도 회전).</summary>
        static void OrbitNext(ref double x, ref double y, int blades)
        {
            double ox = x, oy = y;
            if (blades == 2)
            {
                x = -ox;
                y = -oy;
            }
            else if (blades == 3)
            {
                x = ox * Rot120C - oy * Rot120S;
                y = ox * Rot120S + oy * Rot120C;
            }
            else if (blades == 6)
            {
                x = ox * Rot60C - oy * Rot60S;
                y = ox * Rot60S + oy * Rot60C;
            }
            else
            {
                x = -oy;
                y = ox;
            }
        }

        /// <summary>공전 칼날 개수 (진화하면 6개).</summary>
        public int OrbitCount()
        {
            int lv = Levels[Up.Orbit];
            if (lv == 0) return 0;
            return Levels[Up.Tempest] > 0 ? Defs.TempestBlades : Defs.OrbitBlades[lv - 1];
        }

        public double OrbitRadiusNow()
        {
            int lv = Levels[Up.Orbit];
            if (lv == 0) return 0;
            return Levels[Up.Tempest] > 0 ? Defs.TempestRadius : Defs.OrbitRadius[lv - 1];
        }

        /// <summary>렌더러가 칼날 위치를 그릴 때 쓰는 헬퍼. dirs에 (x, y) 방향을 채우고 개수를 반환.</summary>
        public int OrbitBlades(double[] dirs)
        {
            int blades = OrbitCount();
            double bx = OrbX, by = OrbY;
            for (int k = 0; k < blades; k++)
            {
                dirs[k * 2] = bx;
                dirs[k * 2 + 1] = by;
                OrbitNext(ref bx, ref by, blades);
            }
            return blades;
        }

        // ───────────────────────── 탄환 / 경험치 ─────────────────────────

        void UpdateBullets()
        {
            Player p = Player;
            List<Bullet> bs = Bullets;
            bool lance = Levels[Up.SunLance] > 0;
            int w = 0;
            for (int i = 0; i < bs.Count; i++)
            {
                Bullet b = bs[i];
                b.Px = b.X;
                b.Py = b.Y;
                b.X += b.Vx * Defs.DT;
                b.Y += b.Vy * Defs.DT;
                bool alive = --b.Life > 0 && b.X > 0 && b.X < Defs.Arena && b.Y > 0 && b.Y < Defs.Arena;
                if (alive && b.Hostile)
                {
                    double dx = b.X - p.X;
                    double dy = b.Y - p.Y;
                    double rr = Defs.PlayerR + 4;
                    if (dx * dx + dy * dy < rr * rr && p.DashT == 0)
                    {
                        if (p.Iframes == 0) HurtPlayer(b.Dmg);
                        alive = false;
                    }
                }
                else if (alive)
                {
                    int n = Query(b.X, b.Y, 5);
                    for (int k = 0; k < n; k++)
                    {
                        Enemy e = Enemies[scratch[k]];
                        if (e.Id == b.LastHit) continue;
                        b.LastHit = e.Id;
                        if (lance) blasts.Add(new Blast { X = e.X, Y = e.Y, R = Defs.SunLanceBlastR, Dmg = b.Dmg * Defs.SunLanceBlastMul, HurtsPlayer = false });
                        DamageEnemy(e, b.Dmg, b.Vx * 0.22, b.Vy * 0.22);
                        if (b.Pierce-- <= 0) alive = false;
                        break;
                    }
                }
                if (alive) bs[w++] = b;
            }
            bs.RemoveRange(w, bs.Count - w);
        }

        void DropGem(double x, double y, int value)
        {
            if (Gems.Count >= MaxGems)
            {
                // 상한을 넘으면 새로 만들지 않고 가장 오래된 보석에 합친다.
                Gems[0].Value += value;
                return;
            }
            Gems.Add(new Gem { X = x, Y = y, Px = x, Py = y, Value = value });
        }

        void UpdateGems()
        {
            Player p = Player;
            List<Gem> gs = Gems;
            double mag2 = magnet * magnet;
            int w = 0;
            for (int i = 0; i < gs.Count; i++)
            {
                Gem g = gs[i];
                g.Px = g.X;
                g.Py = g.Y;
                double dx = p.X - g.X;
                double dy = p.Y - g.Y;
                double d2 = dx * dx + dy * dy;
                if (!g.Pulled && d2 < mag2) g.Pulled = true;
                if (g.Pulled)
                {
                    if (d2 < 22 * 22)
                    {
                        GainXp(g.Value);
                        continue;
                    }
                    double d = Math.Sqrt(d2);
                    g.X += (dx / d) * 560 * Defs.DT;
                    g.Y += (dy / d) * 560 * Defs.DT;
                }
                gs[w++] = g;
            }
            gs.RemoveRange(w, gs.Count - w);

            // 보물 상자: 자석에 끌려오지 않으므로 직접 가서 주워야 한다 (위험 감수 보상).
            List<Chest> cs = Chests;
            w = 0;
            for (int i = 0; i < cs.Count; i++)
            {
                Chest c = cs[i];
                double dx = p.X - c.X;
                double dy = p.Y - c.Y;
                if (dx * dx + dy * dy < Defs.ElitePickR * Defs.ElitePickR)
                {
                    PendingLevels++;
                    if (Emit) Events.Add(new SimEvent { Type = EventType.Chest });
                    continue;
                }
                cs[w++] = c;
            }
            cs.RemoveRange(w, cs.Count - w);
        }

        void GainXp(int value)
        {
            Player p = Player;
            p.Xp += value;
            if (Emit) Events.Add(new SimEvent { Type = EventType.Gem });
            while (p.Xp >= p.XpNext)
            {
                p.Xp -= p.XpNext;
                p.Level++;
                p.XpNext = XpForLevel(p.Level);
                PendingLevels++;
            }
        }

        // ───────────────────────── 레벨업 ─────────────────────────

        /// <summary>진화 조건(무기 MAX + 짝 패시브 Lv2 이상)을 만족하고 아직 진화하지 않았는지.</summary>
        public static bool CanEvolve(int[] levels, int evo)
        {
            foreach (Evolution ev in Defs.Evolutions)
            {
                if (ev.Evo != evo) continue;
                return levels[evo] == 0 && levels[ev.Weapon] >= Defs.UpgradeMax && levels[ev.Passive] >= Defs.EvoPassiveLv;
            }
            return false;
        }

        void RollChoices()
        {
            // 진화 가능한 것은 무작위 없이 앞자리에 고정으로 보여 준다.
            Choices.Clear();
            for (int i = 0; i < Defs.Evolutions.Length && Choices.Count < 3; i++)
            {
                if (CanEvolve(Levels, Defs.Evolutions[i].Evo)) Choices.Add(Defs.Evolutions[i].Evo);
            }
            pool.Clear();
            for (int i = 0; i < Defs.BaseUpgrades; i++)
            {
                if (Levels[i] < Defs.UpgradeMax) pool.Add(i);
            }
            if (Choices.Count == 0 && pool.Count == 0)
            {
                // 전부 최대 레벨이면 선택 없이 회복으로 대체
                Player.Hp = Math.Min(Player.MaxHp, Player.Hp + 15 * PendingLevels);
                PendingLevels = 0;
                Phase = Phase.Playing;
                return;
            }
            int k = Math.Min(3 - Choices.Count, pool.Count);
            for (int i = 0; i < k; i++)
            {
                int j = i + Rng.NextInt(pool.Count - i);
                int t = pool[i];
                pool[i] = pool[j];
                pool[j] = t;
                Choices.Add(pool[i]);
            }
            Phase = Phase.LevelUp;
            if (Emit) Events.Add(new SimEvent { Type = EventType.LevelUp });
        }

        void ApplyUpgrade(int idx)
        {
            Levels[idx]++;
            if (idx == Up.Vital)
            {
                Player.MaxHp += 20;
                Player.Hp = Math.Min(Player.MaxHp, Player.Hp + 20);
            }
            if (idx >= Defs.BaseUpgrades && Emit) Events.Add(new SimEvent { Type = EventType.Evolve, Kind = idx });
            RecomputeStats();
        }

        // ───────────────────────── 결과 / 체크섬 ─────────────────────────

        /// <summary>상태 요약 해시(FNV-1a). TS 버전의 checksum()과 같은 값을 낸다.</summary>
        public uint Checksum()
        {
            unchecked
            {
                int h = (int)0x811c9dc5;
                h = (h ^ Tick) * 0x01000193;
                h = (h ^ Score) * 0x01000193;
                h = (h ^ Kills) * 0x01000193;
                h = (h ^ Player.Level) * 0x01000193;
                h = (h ^ (int)Math.Floor(Player.Hp * 1000)) * 0x01000193;
                h = (h ^ (int)Math.Floor(Player.X * 1000)) * 0x01000193;
                h = (h ^ (int)Math.Floor(Player.Y * 1000)) * 0x01000193;
                h = (h ^ Enemies.Count) * 0x01000193;
                h = (h ^ BestCombo) * 0x01000193;
                h = (h ^ Chests.Count) * 0x01000193;
                h = (h ^ Rng.S) * 0x01000193;
                return (uint)h;
            }
        }

        public RunResult Result()
        {
            return new RunResult
            {
                Score = Score,
                Kills = Kills,
                Ticks = Tick,
                Level = Player.Level,
                Won = Phase == Phase.Won,
                Finished = Phase == Phase.Won || Phase == Phase.Dead,
                Checksum = Checksum(),
            };
        }
    }
}
