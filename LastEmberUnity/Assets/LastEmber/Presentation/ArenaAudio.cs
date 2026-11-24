using System;
using UnityEngine;

namespace LastEmber.UnityClient
{
    internal enum Sfx
    {
        Shoot, Hit, Kill, Gem, Dash, Hurt, Nova, Chain, EnemyShoot, LevelUp, Pick, Warn, Win, Blast, Chest, Evolve, Lose,
        Count,
    }

    /// <summary>
    /// 효과음과 음악. client/src/audio.ts의 포팅.
    /// 효과음은 웹과 같은 식(오실레이터 + 대역 통과 잡음)으로 시작할 때 한 번 합성해 AudioClip으로 들고 있고,
    /// 재생은 미리 만든 AudioSource 풀을 돌려 쓰므로 플레이 중 할당이 없다.
    /// 경고음(WAV)과 배경음(MP3)은 Resources/LastEmber/audio에서 읽는다.
    /// </summary>
    internal sealed class ArenaAudio
    {
        enum Wave { Sine, Triangle, Square, Saw }

        const int Rate = 44100;
        const float Master = 0.5f;
        const float MusicGain = 0.18f;
        const float MusicLoopSeconds = 16f;
        const float WarningGain = 0.55f;
        const int Voices = 16;
        const string MutedKey = "ember.muted";

        static readonly float[] MinGap =
        {
            0.07f, 0.04f, 0.05f, 0.03f, 0.1f, 0.1f, 0.1f, 0.08f, 0.12f, 0.2f, 0.05f, 0.5f, 1f, 0.06f, 0.3f, 0.5f, 1f,
        };

        readonly GameObject root;
        readonly AudioSource[] voices = new AudioSource[Voices];
        readonly AudioSource music;
        readonly AudioClip[] clips = new AudioClip[(int)Sfx.Count];
        readonly float[] last = new float[(int)Sfx.Count];
        readonly AudioClip fuseClip;
        readonly AudioClip chargeClip;
        float lastFuse = -10f;
        float lastCharge = -10f;
        int nextVoice;
        int gemStreak;
        float gemAt = -10f;
        bool muted;
        AudioClip musicClip;

        public ArenaAudio(Transform parent)
        {
            root = new GameObject("ArenaAudio");
            root.transform.SetParent(parent, false);
            for (int i = 0; i < Voices; i++)
            {
                AudioSource s = root.AddComponent<AudioSource>();
                s.playOnAwake = false;
                s.spatialBlend = 0f;
                s.loop = false;
                voices[i] = s;
            }

            music = root.AddComponent<AudioSource>();
            music.playOnAwake = false;
            music.spatialBlend = 0f;
            music.loop = true;
            music.volume = 0f;

            for (int i = 0; i < last.Length; i++) last[i] = -10f;
            BuildClips();
            fuseClip = Resources.Load<AudioClip>("LastEmber/audio/bomber-fuse");
            chargeClip = Resources.Load<AudioClip>("LastEmber/audio/boss-charge");
            musicClip = LoadMusic();
            music.clip = musicClip;

            muted = PlayerPrefs.GetInt(MutedKey, 0) == 1;
            ApplyMute();
        }

        public bool Muted
        {
            get => muted;
            set
            {
                if (muted == value) return;
                muted = value;
                PlayerPrefs.SetInt(MutedKey, muted ? 1 : 0);
                ApplyMute();
            }
        }

        void ApplyMute()
        {
            for (int i = 0; i < voices.Length; i++) voices[i].mute = muted;
            music.mute = muted;
        }

        public void SetMusic(bool on)
        {
            if (music.clip == null) return;
            music.volume = on ? MusicGain * Master : 0f;
            if (on && !music.isPlaying) music.Play();
        }

        public void Destroy()
        {
            if (root != null) UnityEngine.Object.Destroy(root);
            for (int i = 0; i < clips.Length; i++)
            {
                if (clips[i] != null) UnityEngine.Object.Destroy(clips[i]);
            }
        }

        // ───────────────────────── 재생 ─────────────────────────

        bool Gate(Sfx id)
        {
            if (muted) return false;
            float now = Time.realtimeSinceStartup;
            int i = (int)id;
            if (now - last[i] < MinGap[i]) return false;
            last[i] = now;
            return true;
        }

        void Play(AudioClip clip, float volume, float pitch)
        {
            if (clip == null) return;
            AudioSource s = null;
            for (int k = 0; k < Voices; k++)
            {
                AudioSource c = voices[(nextVoice + k) % Voices];
                if (!c.isPlaying)
                {
                    s = c;
                    nextVoice = (nextVoice + k + 1) % Voices;
                    break;
                }
            }

            if (s == null)
            {
                s = voices[nextVoice];
                nextVoice = (nextVoice + 1) % Voices;
            }

            s.clip = clip;
            s.volume = volume;
            s.pitch = pitch;
            s.Play();
        }

        public void Play(Sfx id)
        {
            if (id == Sfx.Gem)
            {
                PlayGem();
                return;
            }

            if (Gate(id)) Play(clips[(int)id], Master, 1f);
        }

        void PlayGem()
        {
            if (!Gate(Sfx.Gem)) return;
            // 연속으로 주울수록 음이 올라간다
            float now = Time.realtimeSinceStartup;
            gemStreak = now - gemAt < 0.35f ? Mathf.Min(gemStreak + 1, 12) : 0;
            gemAt = now;
            Play(clips[(int)Sfx.Gem], Master, Mathf.Pow(2f, gemStreak / 12f));
        }

        /// <summary>자폭병 도화선(true) 또는 보스 돌진(false) 경고음. 파일이 없으면 합성 경고음을 낸다.</summary>
        public void Warning(bool fuse)
        {
            if (muted) return;
            float now = Time.realtimeSinceStartup;
            float gap = fuse ? 0.25f : 0.5f;
            if (now - (fuse ? lastFuse : lastCharge) < gap) return;
            if (fuse) lastFuse = now;
            else lastCharge = now;
            AudioClip clip = fuse ? fuseClip : chargeClip;
            if (clip == null)
            {
                Play(Sfx.Warn);
                return;
            }

            Play(clip, WarningGain * Master, 1f);
        }

        // ───────────────────────── 음악 ─────────────────────────

        static AudioClip LoadMusic()
        {
            AudioClip src = Resources.Load<AudioClip>("LastEmber/audio/arena-loop");
            if (src == null) return null;
            // 웹은 앞 16초만 반복한다(MP3 끝의 무음 패딩 제거). 더 긴 파일이면 16초짜리 클립으로 잘라 이음매 없이 돌린다.
            int loopSamples = Mathf.RoundToInt(MusicLoopSeconds * src.frequency);
            if (src.samples <= loopSamples + src.frequency / 50) return src;
            float[] data = new float[loopSamples * src.channels];
            if (!src.GetData(data, 0)) return src;
            AudioClip trimmed = AudioClip.Create("arena-loop-16s", loopSamples, src.channels, src.frequency, false);
            trimmed.SetData(data, 0);
            Resources.UnloadAsset(src);
            return trimmed;
        }

        // ───────────────────────── 합성 ─────────────────────────

        static float[] noise;

        void BuildClips()
        {
            noise = new float[Rate / 2];
            uint x = 0x9E3779B9u;
            for (int i = 0; i < noise.Length; i++)
            {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                noise[i] = (x & 0xFFFFFF) / (float)0x800000 - 1f;
            }

            clips[(int)Sfx.Shoot] = Make("shoot", 0.1f, b => Tone(b, Wave.Triangle, 720, 320, 0.07f, 0.06f, 0f));
            clips[(int)Sfx.Hit] = Make("hit", 0.08f, b => Hiss(b, 0.05f, 0.1f, 2400, 0.8f));
            clips[(int)Sfx.Kill] = Make("kill", 0.2f, b =>
            {
                Tone(b, Wave.Square, 300, 70, 0.14f, 0.07f, 0f);
                Hiss(b, 0.12f, 0.1f, 900, 1f);
            });
            // 기준음 660Hz. 연속 획득 시 AudioSource.pitch로 올린다.
            clips[(int)Sfx.Gem] = Make("gem", 0.12f, b => Tone(b, Wave.Sine, 660, 990, 0.08f, 0.07f, 0f));
            clips[(int)Sfx.Dash] = Make("dash", 0.25f, b => Hiss(b, 0.2f, 0.16f, 1400, 0.5f));
            clips[(int)Sfx.Hurt] = Make("hurt", 0.35f, b =>
            {
                Tone(b, Wave.Saw, 180, 45, 0.3f, 0.22f, 0f);
                Hiss(b, 0.2f, 0.2f, 300, 1f);
            });
            clips[(int)Sfx.Nova] = Make("nova", 0.45f, b =>
            {
                Tone(b, Wave.Sine, 140, 40, 0.4f, 0.22f, 0f);
                Hiss(b, 0.3f, 0.1f, 500, 0.4f);
            });
            clips[(int)Sfx.Chain] = Make("chain", 0.16f, b =>
            {
                Hiss(b, 0.12f, 0.14f, 5200, 2f);
                Tone(b, Wave.Saw, 1500, 280, 0.1f, 0.04f, 0f);
            });
            clips[(int)Sfx.EnemyShoot] = Make("enemyShoot", 0.14f, b => Tone(b, Wave.Square, 240, 160, 0.1f, 0.04f, 0f));
            clips[(int)Sfx.LevelUp] = Make("levelUp", 0.45f, b =>
            {
                float[] f = { 523, 659, 784, 1047 };
                for (int i = 0; i < f.Length; i++) Tone(b, Wave.Triangle, f[i], f[i], 0.16f, 0.12f, i * 0.07f);
            });
            clips[(int)Sfx.Pick] = Make("pick", 0.16f, b => Tone(b, Wave.Triangle, 880, 1320, 0.12f, 0.12f, 0f));
            clips[(int)Sfx.Warn] = Make("warn", 1.2f, b =>
            {
                for (int i = 0; i < 3; i++) Tone(b, Wave.Saw, 110, 104, 0.32f, 0.16f, i * 0.4f);
            });
            clips[(int)Sfx.Win] = Make("win", 0.95f, b =>
            {
                float[] f = { 523, 659, 784, 1047, 1319, 1568 };
                for (int i = 0; i < f.Length; i++) Tone(b, Wave.Triangle, f[i], f[i], 0.34f, 0.14f, i * 0.11f);
            });
            clips[(int)Sfx.Blast] = Make("blast", 0.35f, b =>
            {
                Tone(b, Wave.Sine, 110, 35, 0.3f, 0.2f, 0f);
                Hiss(b, 0.25f, 0.16f, 380, 0.5f);
            });
            clips[(int)Sfx.Chest] = Make("chest", 0.4f, b =>
            {
                float[] f = { 784, 988, 1175, 1568 };
                for (int i = 0; i < f.Length; i++) Tone(b, Wave.Sine, f[i], f[i] * 1.01f, 0.2f, 0.12f, i * 0.05f);
            });
            clips[(int)Sfx.Evolve] = Make("evolve", 0.9f, b =>
            {
                float[] f = { 262, 392, 523, 784, 1047 };
                for (int i = 0; i < f.Length; i++) Tone(b, Wave.Saw, f[i], f[i], 0.3f, 0.07f, i * 0.06f);
                Tone(b, Wave.Sine, 60, 30, 0.8f, 0.25f, 0f);
            });
            clips[(int)Sfx.Lose] = Make("lose", 1.05f, b =>
            {
                float[] f = { 392, 330, 262, 196 };
                for (int i = 0; i < f.Length; i++) Tone(b, Wave.Saw, f[i], f[i] * 0.96f, 0.4f, 0.1f, i * 0.18f);
            });
            noise = null;
        }

        static AudioClip Make(string name, float seconds, Action<float[]> fill)
        {
            float[] buf = new float[Mathf.CeilToInt(seconds * Rate)];
            fill(buf);
            for (int i = 0; i < buf.Length; i++) buf[i] = Mathf.Clamp(buf[i], -1f, 1f);
            AudioClip clip = AudioClip.Create("lastember-" + name, buf.Length, 1, Rate, false);
            clip.SetData(buf, 0);
            return clip;
        }

        static float PolyBlep(float t, float dt)
        {
            if (t < dt)
            {
                t /= dt;
                return t + t - t * t - 1f;
            }

            if (t > 1f - dt)
            {
                t = (t - 1f) / dt;
                return t * t + t + t + 1f;
            }

            return 0f;
        }

        static float Osc(Wave w, float phase, float dt)
        {
            switch (w)
            {
                case Wave.Sine:
                    return Mathf.Sin(phase * 2f * Mathf.PI);
                case Wave.Triangle:
                    return phase < 0.5f ? 4f * phase - 1f : 3f - 4f * phase;
                case Wave.Square:
                    return (phase < 0.5f ? 1f : -1f) + PolyBlep(phase, dt) - PolyBlep(phase < 0.5f ? phase + 0.5f : phase - 0.5f, dt);
                default:
                    return 2f * phase - 1f - PolyBlep(phase, dt);
            }
        }

        /// <summary>Web Audio의 oscillator + exponentialRamp(주파수, 게인)와 같은 모양의 톤을 버퍼에 더한다.</summary>
        static void Tone(float[] buf, Wave wave, float f0, float f1, float dur, float vol, float delay)
        {
            int start = Mathf.RoundToInt(delay * Rate);
            int n = Mathf.RoundToInt(dur * Rate);
            f1 = Mathf.Max(20f, f1);
            float logF = Mathf.Log(f1 / f0);
            float logG = Mathf.Log(0.0001f / vol);
            float phase = 0f;
            for (int i = 0; i < n && start + i < buf.Length; i++)
            {
                float t = i / (float)n;
                float f = f0 * Mathf.Exp(logF * t);
                float g = vol * Mathf.Exp(logG * t);
                float dt = f / Rate;
                phase += dt;
                phase -= Mathf.Floor(phase);
                buf[start + i] += g * Osc(wave, phase, dt);
            }
        }

        /// <summary>백색 잡음을 대역 통과 필터(RBJ)와 지수 감쇠 게인에 통과시켜 더한다.</summary>
        static void Hiss(float[] buf, float dur, float vol, float freq, float q)
        {
            int n = Mathf.Min(Mathf.RoundToInt(dur * Rate), buf.Length);
            float w0 = 2f * Mathf.PI * freq / Rate;
            float alpha = Mathf.Sin(w0) / (2f * q);
            float a0 = 1f + alpha;
            float b0 = alpha / a0;
            float b2 = -alpha / a0;
            float a1 = -2f * Mathf.Cos(w0) / a0;
            float a2 = (1f - alpha) / a0;
            float logG = Mathf.Log(0.0001f / vol);
            float x1 = 0f, x2 = 0f, y1 = 0f, y2 = 0f;
            for (int i = 0; i < n; i++)
            {
                float x0 = noise[i % noise.Length];
                float y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2;
                x2 = x1;
                x1 = x0;
                y2 = y1;
                y1 = y0;
                buf[i] += y0 * vol * Mathf.Exp(logG * (i / (float)n));
            }
        }
    }
}
