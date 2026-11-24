using System;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.Rendering;

namespace LastEmber.UnityClient
{
    /// <summary>텍스처 사각형 UV 범위. V는 아래에서 위로 늘어난다(유니티 규약).</summary>
    internal readonly struct UvRect
    {
        public readonly float U0, V0, U1, V1;

        public UvRect(float u0, float v0, float u1, float v1)
        {
            U0 = u0; V0 = v0; U1 = u1; V1 = v1;
        }
    }

    /// <summary>
    /// 한 머티리얼로 그려지는 사각형을 한 메시에 모아 프레임마다 통째로 올린다.
    /// 좌표는 시뮬레이션 좌표(Y 아래로 증가)로 받고 월드(Y 위로 증가, 0.01배)로 바꿔 쓴다.
    /// 버퍼는 필요할 때만 늘어나므로 정상 상태의 프레임에서는 할당이 없다.
    /// </summary>
    internal sealed class QuadBatch
    {
        public const float WorldPerSim = 0.01f;
        const int MaxQuads = 16000; // UInt16 인덱스 한계(65535 정점)
        const MeshUpdateFlags Flags = MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices;

        [StructLayout(LayoutKind.Sequential)]
        struct Vertex
        {
            public Vector3 Position;
            public Color32 Color;
            public Vector2 Uv;
        }

        static readonly VertexAttributeDescriptor[] Layout =
        {
            new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4),
            new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 2),
        };

        readonly GameObject go;
        readonly Mesh mesh;
        readonly MeshRenderer meshRenderer;
        Vertex[] verts;
        int capacity;
        int quads;

        public QuadBatch(Transform parent, string name, Material material, int sortingOrder, int initialQuads)
        {
            go = new GameObject(name);
            go.transform.SetParent(parent, false);
            MeshFilter filter = go.AddComponent<MeshFilter>();
            meshRenderer = go.AddComponent<MeshRenderer>();
            mesh = new Mesh { name = name };
            mesh.MarkDynamic();
            filter.sharedMesh = mesh;
            meshRenderer.sharedMaterial = material;
            meshRenderer.sortingOrder = sortingOrder;
            meshRenderer.shadowCastingMode = ShadowCastingMode.Off;
            meshRenderer.receiveShadows = false;
            meshRenderer.lightProbeUsage = LightProbeUsage.Off;
            meshRenderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            meshRenderer.enabled = false;
            Allocate(Mathf.Max(16, initialQuads), false);
        }

        public Material Material => meshRenderer.sharedMaterial;

        void Allocate(int newCapacity, bool keep)
        {
            if (keep) Array.Resize(ref verts, newCapacity * 4);
            else verts = new Vertex[newCapacity * 4];
            capacity = newCapacity;

            ushort[] indices = new ushort[newCapacity * 6];
            for (int q = 0; q < newCapacity; q++)
            {
                int i = q * 6;
                int v = q * 4;
                indices[i] = (ushort)v;
                indices[i + 1] = (ushort)(v + 1);
                indices[i + 2] = (ushort)(v + 2);
                indices[i + 3] = (ushort)v;
                indices[i + 4] = (ushort)(v + 2);
                indices[i + 5] = (ushort)(v + 3);
            }

            mesh.Clear();
            mesh.SetVertexBufferParams(newCapacity * 4, Layout);
            mesh.SetIndexBufferParams(indices.Length, IndexFormat.UInt16);
            mesh.SetIndexBufferData(indices, 0, 0, indices.Length, Flags);
            mesh.subMeshCount = 1;
            mesh.SetSubMesh(0, new SubMeshDescriptor(0, 0, MeshTopology.Triangles), Flags);
            // 정점이 월드 좌표로 들어가므로 컬링에 걸리지 않게 경계를 크게 잡아 둔다.
            mesh.bounds = new Bounds(Vector3.zero, new Vector3(1000f, 1000f, 10f));
        }

        public void Begin()
        {
            quads = 0;
        }

        /// <summary>
        /// 사각형 하나. 꼭짓점은 (왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래) 순서이고
        /// 시뮬레이션 좌표로 준다. 이미지의 위쪽은 UV의 V1에 대응한다.
        /// </summary>
        public void Add(float x0, float y0, float x1, float y1, float x2, float y2, float x3, float y3,
            float u0, float v0, float u1, float v1, Color32 color)
        {
            if (quads >= capacity)
            {
                if (capacity >= MaxQuads) return;
                Allocate(Mathf.Min(MaxQuads, capacity * 2), true);
            }

            int i = quads * 4;
            quads++;
            const float s = WorldPerSim;
            verts[i] = new Vertex { Position = new Vector3(x0 * s, -y0 * s, 0f), Color = color, Uv = new Vector2(u0, v1) };
            verts[i + 1] = new Vertex { Position = new Vector3(x1 * s, -y1 * s, 0f), Color = color, Uv = new Vector2(u1, v1) };
            verts[i + 2] = new Vertex { Position = new Vector3(x2 * s, -y2 * s, 0f), Color = color, Uv = new Vector2(u1, v0) };
            verts[i + 3] = new Vertex { Position = new Vector3(x3 * s, -y3 * s, 0f), Color = color, Uv = new Vector2(u0, v0) };
        }

        public void Add(float x0, float y0, float x1, float y1, float x2, float y2, float x3, float y3,
            in UvRect uv, Color32 color)
        {
            Add(x0, y0, x1, y1, x2, y2, x3, y3, uv.U0, uv.V0, uv.U1, uv.V1, color);
        }

        /// <summary>모은 사각형을 GPU로 올린다.</summary>
        public void End()
        {
            if (quads == 0)
            {
                meshRenderer.enabled = false;
                return;
            }

            mesh.SetVertexBufferData(verts, 0, 0, quads * 4, 0, Flags);
            mesh.SetSubMesh(0, new SubMeshDescriptor(0, quads * 6, MeshTopology.Triangles), Flags);
            meshRenderer.enabled = true;
        }

        public void Destroy()
        {
            if (go != null) UnityEngine.Object.Destroy(go);
            if (mesh != null) UnityEngine.Object.Destroy(mesh);
        }
    }
}
