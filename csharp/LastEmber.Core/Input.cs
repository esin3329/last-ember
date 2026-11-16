// 입력 프레임과 리플레이 재실행. shared/input.ts, shared/replay.ts에 대응한다.

using System.Collections.Generic;

namespace LastEmber.Core
{
    public struct InputFrame
    {
        public int Mx;      // -1 | 0 | 1
        public int My;      // -1 | 0 | 1
        public bool Dash;
        public int Choice;  // -1(없음) | 0 | 1 | 2

        // 비트 배치: [6..5] choice+1, [4] dash, [3..0] 이동(0~8)
        public int Encode()
        {
            return (Mx + 1) + (My + 1) * 3 + (Dash ? 16 : 0) + ((Choice + 1) << 5);
        }

        public static InputFrame Decode(int code)
        {
            int mv = code & 15;
            return new InputFrame
            {
                Mx = mv % 3 - 1,
                My = mv / 3 - 1,
                Dash = (code & 16) != 0,
                Choice = ((code >> 5) & 3) - 1,
            };
        }

        public static bool IsValidCode(int code)
        {
            return code >= 0 && code < 128 && (code & 15) <= 8;
        }
    }

    /// <summary>입력 코드를 [code, count, code, count, ...] 형태로 기록한다.</summary>
    public sealed class InputRecorder
    {
        public readonly List<int> Runs = new List<int>();
        public int Total;

        public void Push(int code)
        {
            int n = Runs.Count;
            if (n > 0 && Runs[n - 2] == code) Runs[n - 1]++;
            else { Runs.Add(code); Runs.Add(1); }
            Total++;
        }
    }

    public struct RunResult
    {
        public int Score, Kills, Ticks, Level;
        public bool Won, Finished;
        public uint Checksum;
    }

    public static class Replay
    {
        /// <summary>시드와 RLE 입력으로 처음부터 끝까지 시뮬레이션을 돌려 결과를 낸다.</summary>
        public static RunResult Simulate(int seed, IReadOnlyList<int> runs)
        {
            var sim = new Sim(seed, false);
            for (int i = 0; i + 1 < runs.Count; i += 2)
            {
                InputFrame frame = InputFrame.Decode(runs[i]);
                for (int c = runs[i + 1]; c > 0; c--)
                {
                    sim.Step(frame);
                    if (sim.Phase == Phase.Dead || sim.Phase == Phase.Won) return sim.Result();
                }
            }
            return sim.Result();
        }
    }
}
