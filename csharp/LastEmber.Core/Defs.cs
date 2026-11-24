// 데이터 테이블. shared/defs.ts와 값이 같아야 한다(다르면 리플레이가 어긋난다).

namespace LastEmber.Core
{
    public static class Kind
    {
        public const int Chaser = 0;
        public const int Runner = 1;
        public const int Tank = 2;
        public const int Shooter = 3;
        public const int Boss = 4;
        public const int Bomber = 5;
    }

    public static class Up
    {
        public const int Bolt = 0;
        public const int Orbit = 1;
        public const int Nova = 2;
        public const int Chain = 3;
        public const int Might = 4;
        public const int Haste = 5;
        public const int Swift = 6;
        public const int Vital = 7;
        public const int Magnet = 8;
        public const int Regen = 9;
        // 진화 (무기 MAX + 짝 패시브 Lv2 이상일 때만 선택지에 나온다)
        public const int SunLance = 10;
        public const int Tempest = 11;
        public const int Bloom = 12;
        public const int Thunder = 13;
    }

    public readonly struct EnemyDef
    {
        public readonly double Hp, Speed, Dmg, R, Kb;
        public readonly int Xp, Score;

        public EnemyDef(double hp, double speed, double dmg, double r, int xp, int score, double kb)
        {
            Hp = hp; Speed = speed; Dmg = dmg; R = r; Xp = xp; Score = score; Kb = kb;
        }
    }

    public readonly struct Evolution
    {
        public readonly int Evo, Weapon, Passive;

        public Evolution(int evo, int weapon, int passive)
        {
            Evo = evo; Weapon = weapon; Passive = passive;
        }
    }

    public static class Defs
    {
        // 규칙 버전. shared/defs.ts와 같다. v2는 구간 시드 없음, v3(랭킹)는 SegmentFrames마다 RNG를 새 시드로 맞춘다.
        public const int SimVersion = 3;
        public const int LegacySimVersion = 2;

        /// <summary>구간 길이. Step() 호출 수(입력 프레임) 기준(60프레임은 보통 약 1초)이며 시뮬레이션 틱과 다르다.</summary>
        public const int SegmentFrames = 60;

        /// <summary>버전별 구간 길이. 모르는 버전이면 -1.</summary>
        public static int SegmentFramesFor(int version)
        {
            return version == LegacySimVersion ? 0 : version == SimVersion ? SegmentFrames : -1;
        }

        public const int TickRate = 60;
        public const double DT = 1.0 / TickRate;
        public const double Arena = 2400;
        public const int BossTick = 180 * TickRate;
        public const int MaxTicks = 600 * TickRate;

        public const double PlayerR = 12;
        public const double PlayerSpeed = 230;
        public const double PlayerHp = 100;
        public const int DashTicks = 11;
        public const int DashCd = 80;
        public const double DashSpeed = 760;
        public const int HitIframes = 40;

        public const int BaseUpgrades = 10;
        public const int UpgradeCount = 14;
        public const int UpgradeMax = 5;
        public const int EvoPassiveLv = 2;

        public static int MaxLevel(int up) => up >= BaseUpgrades ? 1 : UpgradeMax;

        public static readonly EnemyDef[] Enemies =
        {
            new EnemyDef(12, 92, 9, 11, 1, 10, 1),      // Chaser
            new EnemyDef(7, 168, 7, 8, 1, 12, 1.2),     // Runner
            new EnemyDef(70, 56, 18, 20, 6, 60, 0.35),  // Tank
            new EnemyDef(20, 78, 8, 12, 3, 30, 1),      // Shooter
            new EnemyDef(5600, 84, 26, 44, 0, 5000, 0), // Boss
            new EnemyDef(16, 122, 6, 12, 2, 25, 1.1),   // Bomber
        };

        public static readonly Evolution[] Evolutions =
        {
            new Evolution(Up.SunLance, Up.Bolt, Up.Might),
            new Evolution(Up.Tempest, Up.Orbit, Up.Swift),
            new Evolution(Up.Bloom, Up.Nova, Up.Vital),
            new Evolution(Up.Thunder, Up.Chain, Up.Haste),
        };

        // 자폭병
        public const double BomberTrigger = 78;
        public const int BomberFuse = 50;
        public const double BomberRadius = 92;
        public const double BomberDmgPlayer = 24;
        public const double BomberDmgEnemy = 45;

        // 엘리트
        public const int EliteEvery = 45 * TickRate;
        public const double EliteHpMul = 4;
        public const double EliteRMul = 1.45;
        public const double EliteSpeedMul = 1.2;
        public const double EliteDmgMul = 1;
        public const double EliteKbMul = 0.3;
        public const int EliteXpMul = 3;
        public const int EliteScore = 600;
        public const double ElitePickR = 30;

        // 보스 2페이즈 돌진
        public const int ChargeCd = 300;
        public const int ChargeWindup = 54;
        public const int ChargeLock = 20;
        public const int ChargeDash = 36;
        public const double ChargeSpeed = 600;

        public const double BossBlastMul = 0.25;

        // 콤보
        public const int ComboStep = 40;
        public const int ComboMaxTier = 4;

        public static int ComboTier(int combo)
        {
            int t = combo / ComboStep;
            return t > ComboMaxTier ? ComboMaxTier : t;
        }

        // 무기 레벨별 수치 (인덱스 = 레벨 - 1)
        public static readonly int[] BoltCd = { 26, 23, 21, 19, 16 };
        public static readonly int[] BoltCount = { 1, 1, 2, 2, 3 };
        public static readonly double[] BoltDmg = { 10, 14, 15, 19, 23 };
        public static readonly int[] BoltPierce = { 0, 0, 0, 1, 2 };
        public const double BoltSpeed = 540;
        public const double BoltRange = 480;
        public const int BoltLife = 60;

        public static readonly int[] OrbitBlades = { 2, 2, 3, 3, 4 };
        public static readonly double[] OrbitDmg = { 9, 13, 14, 18, 22 };
        public static readonly double[] OrbitRadius = { 72, 78, 78, 86, 92 };
        public const int OrbitHitCd = 22;
        public const double OrbitBladeR = 15;

        public static readonly int[] NovaCd = { 170, 155, 140, 128, 112 };
        public static readonly double[] NovaRadius = { 120, 135, 150, 168, 190 };
        public static readonly double[] NovaDmg = { 18, 25, 32, 40, 50 };
        public const double NovaKb = 300;

        public static readonly int[] ChainCd = { 96, 90, 84, 76, 68 };
        public static readonly int[] ChainJumps = { 3, 4, 5, 6, 8 };
        public static readonly double[] ChainDmg = { 15, 19, 23, 28, 34 };
        public const double ChainRange = 380;
        public const double ChainJumpRange = 175;

        // 진화 무기
        public const double SunLanceDmgMul = 1.25;
        public const int SunLancePierceAdd = 2;
        public const double SunLanceBlastR = 64;
        public const double SunLanceBlastMul = 0.6;

        public const int TempestBlades = 6;
        public const double TempestRadius = 108;
        public const double TempestDmgMul = 1.25;
        public const double TempestEraseR = 24;

        public const double BloomRadiusMul = 1.25;
        public const double BloomHealPerHit = 0.8;
        public const double BloomHealMax = 14;

        public const int ThunderJumps = 12;
        public const double ThunderDmgMul = 1.2;
        public const double ThunderCdMul = 0.8;
        public const int ThunderStun = 36;
    }
}
