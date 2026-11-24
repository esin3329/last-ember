using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace LastEmber.UnityClient.Editor
{
    public static class AndroidBuild
    {
        public static void Build()
        {
            string[] args = Environment.GetCommandLineArgs();
            int outputIndex = Array.IndexOf(args, "-buildOutput");
            if (outputIndex < 0 || outputIndex + 1 == args.Length)
                throw new BuildFailedException("Pass an APK output path with unity build --output.");
            string output = Path.GetFullPath(args[outputIndex + 1]);
            if (!output.EndsWith(".apk", StringComparison.OrdinalIgnoreCase))
                throw new BuildFailedException("The Android build output must end in .apk.");

            Directory.CreateDirectory(Path.GetDirectoryName(output));
            var scenes = EditorBuildSettings.scenes.Where(scene => scene.enabled).Select(scene => scene.path).ToArray();
            if (scenes.Length == 0) throw new BuildFailedException("No enabled scenes in Build Settings.");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = scenes,
                target = BuildTarget.Android,
                locationPathName = output,
                options = BuildOptions.None,
            });
            if (report.summary.result != BuildResult.Succeeded)
                throw new BuildFailedException($"Android build returned {report.summary.result} ({report.summary.totalErrors} errors).");
        }
    }
}
