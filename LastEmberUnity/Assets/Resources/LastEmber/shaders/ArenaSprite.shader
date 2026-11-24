// ArenaView가 쓰는 정점 색상 스프라이트 셰이더. 알파/가산 합성은 _SrcBlend/_DstBlend로 고르고,
// _Flash가 1이면 텍스처의 알파만 남긴 흰 실루엣(피격 섬광)이 된다.
// Resources 폴더에 있어야 플레이어 빌드에 포함된다(ArenaView가 Resources.Load로 가져온다).
Shader "LastEmber/ArenaSprite"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 5
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 10
        _Flash ("Flash", Range(0, 1)) = 0
    }
    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" "PreviewType" = "Plane" }
        Cull Off
        ZWrite Off
        ZTest Always
        Blend [_SrcBlend] [_DstBlend]

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 2.0
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            fixed _Flash;

            struct appdata
            {
                float4 vertex : POSITION;
                fixed4 color : COLOR;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                fixed4 color : COLOR;
                float2 uv : TEXCOORD0;
            };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                fixed4 c = v.color;
                // 정점 색은 sRGB로 적어 두었으므로 선형 색공간 프로젝트에서는 변환한다.
                #ifndef UNITY_COLORSPACE_GAMMA
                c.rgb = GammaToLinearSpace(c.rgb);
                #endif
                o.color = c;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 t = tex2D(_MainTex, i.uv);
                fixed4 c = t * i.color;
                c.rgb = lerp(c.rgb, fixed3(1, 1, 1), _Flash);
                return c;
            }
            ENDCG
        }
    }
    Fallback Off
}
