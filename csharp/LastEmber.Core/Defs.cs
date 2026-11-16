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

    public static class Defs
    {
        public const int SimVersion = 1;

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

        public const int UpgradeCount = 10;
        public const int UpgradeMax = 5;

        public static readonly EnemyDef[] Enemies =
        {
            new EnemyDef(12, 92, 9, 11, 1, 10, 1),      // Chaser
            new EnemyDef(7, 168, 7, 8, 1, 12, 1.2),     // Runner
            new EnemyDef(70, 56, 18, 20, 6, 60, 0.35),  // Tank
            new EnemyDef(20, 78, 8, 12, 3, 30, 1),      // Shooter
            new EnemyDef(4200, 84, 26, 44, 0, 5000, 0), // Boss
        };

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
    }
}
