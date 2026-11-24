#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace LastEmber.UnityClient
{
    /// <summary>
    /// Resources/LastEmber 아래 텍스처·오디오의 임포트 설정을 코드로 고정한다(.meta를 손으로 쓰지 않기 위함).
    /// 텍스처: 압축/밉맵/NPOT 리스케일 없음(96, 192px 스프라이트가 뭉개지지 않게), 바닥은 점 필터 + 반복.
    /// 오디오: 작은 클립이라 로드 시 압축 해제(재생 지연과 GetData 사용을 위해).
    /// 스크립트와 에셋이 같은 새로고침에 들어와 후처리기가 늦게 켜지는 경우를 위해 로드 직후 한 번 점검해 다시 임포트한다.
    /// </summary>
    internal sealed class ArenaAssetImporter : AssetPostprocessor
    {
        const string Root = "Assets/Resources/LastEmber/";

        void OnPreprocessTexture()
        {
            if (assetPath.StartsWith(Root)) ConfigureTexture((TextureImporter)assetImporter);
        }

        void OnPreprocessAudio()
        {
            if (assetPath.StartsWith(Root)) ConfigureAudio((AudioImporter)assetImporter);
        }

        /// <summary>설정을 적용하고 바뀐 것이 있으면 true.</summary>
        static bool ConfigureTexture(TextureImporter ti)
        {
            bool floor = ti.assetPath.Contains("/environment/");
            FilterMode filter = floor ? FilterMode.Point : FilterMode.Bilinear;
            TextureWrapMode wrap = floor ? TextureWrapMode.Repeat : TextureWrapMode.Clamp;
            bool same = ti.textureType == TextureImporterType.Default
                && ti.npotScale == TextureImporterNPOTScale.None
                && !ti.mipmapEnabled
                && !ti.isReadable
                && ti.alphaIsTransparency
                && ti.textureCompression == TextureImporterCompression.Uncompressed
                && ti.filterMode == filter
                && ti.wrapMode == wrap
                && ti.maxTextureSize >= 512;
            if (same) return false;
            ti.textureType = TextureImporterType.Default;
            ti.npotScale = TextureImporterNPOTScale.None;
            ti.mipmapEnabled = false;
            ti.isReadable = false;
            ti.alphaIsTransparency = true;
            ti.textureCompression = TextureImporterCompression.Uncompressed;
            ti.filterMode = filter;
            ti.wrapMode = wrap;
            ti.maxTextureSize = 1024;
            return true;
        }

        static bool ConfigureAudio(AudioImporter ai)
        {
            AudioImporterSampleSettings s = ai.defaultSampleSettings;
            if (s.loadType == AudioClipLoadType.DecompressOnLoad && s.preloadAudioData && !ai.forceToMono) return false;
            s.loadType = AudioClipLoadType.DecompressOnLoad;
            s.preloadAudioData = true;
            ai.defaultSampleSettings = s;
            ai.forceToMono = false;
            return true;
        }

        [InitializeOnLoadMethod]
        static void Verify()
        {
            EditorApplication.delayCall += () =>
            {
                string[] guids = AssetDatabase.FindAssets("t:Texture2D t:AudioClip", new[] { "Assets/Resources/LastEmber" });
                for (int i = 0; i < guids.Length; i++)
                {
                    string path = AssetDatabase.GUIDToAssetPath(guids[i]);
                    AssetImporter importer = AssetImporter.GetAtPath(path);
                    bool changed = importer is TextureImporter ti ? ConfigureTexture(ti)
                        : importer is AudioImporter ai && ConfigureAudio(ai);
                    if (changed) importer.SaveAndReimport();
                }
            };
        }
    }
}
#endif
