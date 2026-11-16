// 교차 검증: TypeScript 시뮬레이션이 만든 리플레이(fixtures.json)를 C# 코어로 재실행해서
// 점수·처치 수·틱 수·체크섬이 전부 같은지 확인한다. 하나라도 다르면 종료 코드 1.
//
//   npm run verify:csharp

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using LastEmber.Core;

static class Program
{
    static int Main(string[] args)
    {
        string path = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "fixtures.json");
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = doc.RootElement;
        int failures = 0;

        // 1) RNG 기준값
        var rng = new Rng(1);
        JsonElement expectedRng = root.GetProperty("rng");
        for (int i = 0; i < expectedRng.GetArrayLength(); i++)
        {
            uint got = rng.NextU32();
            if (got != expectedRng[i].GetUInt32())
            {
                Console.WriteLine($"FAIL rng[{i}]: expected {expectedRng[i].GetUInt32()}, got {got}");
                failures++;
            }
        }

        // 2) 입력 코드 왕복
        for (int code = 0; code < 128; code++)
        {
            if (InputFrame.IsValidCode(code) && InputFrame.Decode(code).Encode() != code)
            {
                Console.WriteLine($"FAIL input code {code} does not round-trip");
                failures++;
            }
        }

        // 3) 리플레이 재실행
        var watch = new Stopwatch();
        long totalTicks = 0;
        foreach (JsonElement run in root.GetProperty("runs").EnumerateArray())
        {
            int seed = run.GetProperty("seed").GetInt32();
            var inputs = new List<int>();
            foreach (JsonElement v in run.GetProperty("inputs").EnumerateArray()) inputs.Add(v.GetInt32());
            JsonElement exp = run.GetProperty("result");

            watch.Start();
            RunResult got = Replay.Simulate(seed, inputs);
            watch.Stop();
            totalTicks += got.Ticks;

            bool same =
                got.Score == exp.GetProperty("score").GetInt32() &&
                got.Kills == exp.GetProperty("kills").GetInt32() &&
                got.Ticks == exp.GetProperty("ticks").GetInt32() &&
                got.Level == exp.GetProperty("level").GetInt32() &&
                got.Won == exp.GetProperty("won").GetBoolean() &&
                got.Finished == exp.GetProperty("finished").GetBoolean() &&
                got.Checksum == exp.GetProperty("checksum").GetUInt32();

            string outcome = got.Won ? "won " : "dead";
            Console.WriteLine($"{(same ? "ok  " : "FAIL")} seed {seed,11}  {outcome} {got.Ticks,6} ticks  score {got.Score,6}  checksum {got.Checksum}");
            if (!same)
            {
                Console.WriteLine($"     expected ticks {exp.GetProperty("ticks").GetInt32()} score {exp.GetProperty("score").GetInt32()} checksum {exp.GetProperty("checksum").GetUInt32()}");
                failures++;
            }
        }

        double us = totalTicks > 0 ? watch.Elapsed.TotalMilliseconds * 1000 / totalTicks : 0;
        Console.WriteLine();
        Console.WriteLine(failures == 0
            ? $"C# 결과가 TypeScript와 일치합니다. ({totalTicks} ticks, 틱당 {us:F1}us)"
            : $"불일치 {failures}건");
        return failures == 0 ? 0 : 1;
    }
}
