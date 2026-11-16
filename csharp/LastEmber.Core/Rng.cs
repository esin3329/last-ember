// 시드 기반 난수 생성기 (mulberry32). shared/rng.ts와 같은 수열을 낸다.
// JS의 32비트 정수 연산(|0, >>>, Math.imul)을 unchecked int/uint 연산으로 옮겼다.

namespace LastEmber.Core
{
    public sealed class Rng
    {
        public int S;

        public Rng(int seed)
        {
            S = seed;
        }

        public uint NextU32()
        {
            unchecked
            {
                S += 0x6d2b79f5;
                int t = (S ^ (int)((uint)S >> 15)) * (1 | S);
                t = (t + (t ^ (int)((uint)t >> 7)) * (61 | t)) ^ t;
                return (uint)(t ^ (int)((uint)t >> 14));
            }
        }

        /// <summary>[0, 1)</summary>
        public double NextFloat()
        {
            return NextU32() / 4294967296.0;
        }

        /// <summary>[0, n) 정수</summary>
        public int NextInt(int n)
        {
            return (int)System.Math.Floor(NextFloat() * n);
        }
    }
}
