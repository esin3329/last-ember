using System.Globalization;
using UnityEngine;

namespace LastEmber.UnityClient
{
    /// <summary>
    /// 떠오르는 데미지 숫자·콤보 문구. TextMesh를 미리 만들어 두고 돌려 쓴다.
    /// 글자는 동적 OS 폰트(한글 폴백 포함)에서 가져오고, 머티리얼은 ArenaSprite 셰이더를 써서
    /// 내장 텍스트 셰이더가 빌드에서 빠지는 문제를 피한다.
    /// </summary>
    internal sealed class ArenaFloatTexts
    {
        const int FontSize = 48;
        const float CharacterSize = 0.1f;
        // TextMesh의 한 글자 높이(em) ≈ characterSize * fontSize / 10 월드 유닛
        const float EmWorld = CharacterSize * FontSize / 10f;

        static readonly string[] FontNames =
        {
            "Noto Sans CJK KR", "Noto Sans KR", "NotoSansCJK-Regular", "Malgun Gothic", "Apple SD Gothic Neo", "Roboto", "Arial",
        };

        static readonly string[] Numbers = new string[1024];
        static readonly string[] Negatives = new string[1024];
        static readonly string[] Combos = new string[8];

        readonly TextMesh[] meshes = new TextMesh[ArenaFx.MaxTexts];
        readonly MeshRenderer[] renderers = new MeshRenderer[ArenaFx.MaxTexts];
        readonly string[] shown = new string[ArenaFx.MaxTexts];
        readonly Font font;
        readonly Material material;
        readonly GameObject root;

        public ArenaFloatTexts(Transform parent, Shader shader, int sortingOrder)
        {
            font = Font.CreateDynamicFontFromOSFont(FontNames, FontSize);
            if (font == null) return;
            // 자주 쓰는 글자를 미리 아틀라스에 올려 전투 중 글리프 생성이 끼지 않게 한다.
            font.RequestCharactersInTexture("0123456789-+.x× 콤보", FontSize, FontStyle.Bold);

            root = new GameObject("ArenaTexts");
            root.transform.SetParent(parent, false);
            material = new Material(shader) { name = "lastember-text", mainTexture = font.material.mainTexture };
            material.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
            material.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            material.SetFloat("_Flash", 0f);

            for (int i = 0; i < meshes.Length; i++)
            {
                GameObject go = new GameObject("t" + i);
                go.transform.SetParent(root.transform, false);
                TextMesh tm = go.AddComponent<TextMesh>();
                tm.font = font;
                tm.fontSize = FontSize;
                tm.fontStyle = FontStyle.Bold;
                tm.characterSize = CharacterSize;
                tm.anchor = TextAnchor.MiddleCenter;
                tm.alignment = TextAlignment.Center;
                tm.richText = false;
                MeshRenderer mr = go.GetComponent<MeshRenderer>();
                mr.sharedMaterial = material;
                mr.sortingOrder = sortingOrder;
                mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                mr.receiveShadows = false;
                mr.enabled = false;
                meshes[i] = tm;
                renderers[i] = mr;
            }
        }

        public static string Number(int value)
        {
            if (value < 0 || value >= Numbers.Length) return value.ToString(CultureInfo.InvariantCulture);
            return Numbers[value] ??= value.ToString(CultureInfo.InvariantCulture);
        }

        public static string Negative(int value)
        {
            if (value < 0 || value >= Negatives.Length) return "-" + value.ToString(CultureInfo.InvariantCulture);
            return Negatives[value] ??= "-" + value.ToString(CultureInfo.InvariantCulture);
        }

        public static string Combo(int tier)
        {
            if (tier < 0 || tier >= Combos.Length) return "콤보";
            return Combos[tier] ??= "콤보 ×" + ((2 + tier) / 2f).ToString("0.#", CultureInfo.InvariantCulture);
        }

        public void Sync(ArenaFx fx)
        {
            if (font == null) return;
            // 아틀라스가 다시 만들어지면 텍스처 참조가 바뀐다.
            Texture atlas = font.material.mainTexture;
            if (material.mainTexture != atlas) material.mainTexture = atlas;

            for (int i = 0; i < meshes.Length; i++)
            {
                if (i >= fx.TextCount)
                {
                    if (renderers[i].enabled) renderers[i].enabled = false;
                    continue;
                }

                ref ArenaFx.FloatText t = ref fx.Texts[i];
                TextMesh tm = meshes[i];
                if (!ReferenceEquals(shown[i], t.Text))
                {
                    shown[i] = t.Text;
                    tm.text = t.Text;
                }

                Color32 c = t.Color;
                c.a = (byte)Mathf.RoundToInt(Mathf.Min(1f, t.Life * 3f) * 255f);
                tm.color = c;
                Transform tr = tm.transform;
                tr.localPosition = new Vector3(t.X * QuadBatch.WorldPerSim, -t.Y * QuadBatch.WorldPerSim, 0f);
                float s = t.Size * QuadBatch.WorldPerSim / EmWorld;
                tr.localScale = new Vector3(s, s, 1f);
                renderers[i].enabled = true;
            }
        }

        public void Destroy()
        {
            if (root != null) Object.Destroy(root);
            if (material != null) Object.Destroy(material);
        }
    }
}
