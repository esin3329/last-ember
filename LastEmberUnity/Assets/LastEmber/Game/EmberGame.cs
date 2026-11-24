using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using LastEmber.Core;
using UnityEngine;
using UnityEngine.InputSystem;

namespace LastEmber.UnityClient
{
    public sealed partial class EmberGame : MonoBehaviour
    {
        enum Mode { Menu, Play, Replay }

        [SerializeField] ArenaView arena;
        [SerializeField] string rankedServer = "";
        [SerializeField] TMPro.TMP_FontAsset font;
        Mode mode;
        Sim sim;
        RankedApi api;
        CancellationTokenSource lifetime;
        InputRecorder recorded, segment;
        readonly List<int> seeds = new List<int>();
        ReplayData lastReplay;
        int seed, replayOffset, replayRemaining, replaySeed;
        int[] replayInputs, replaySeeds;
        string runId;
        float accumulator;
        bool paused, busy, finished, dashQueued, submitBusy, padDash, padPause, padX, padY, padB;
        int choice = -1;
        int replaySpeed = 1;
        Vector2 touch;
        Gamepad activePad, previousPad;
        Func<CancellationToken, Task> submitAgain;

        void Awake()
        {
            Application.targetFrameRate = 60;
            Screen.sleepTimeout = SleepTimeout.NeverSleep;
            api = new RankedApi(rankedServer);
            InputSystem.onDeviceChange += OnInputDeviceChange;
            BuildUi();
            ShowMenu();
        }

        void OnDestroy()
        {
            InputSystem.onDeviceChange -= OnInputDeviceChange;
            lifetime?.Cancel();
            lifetime?.Dispose();
        }

        void OnInputDeviceChange(InputDevice device, InputDeviceChange change)
        {
            if (device != activePad || (change != InputDeviceChange.Disconnected && change != InputDeviceChange.Removed)) return;
            activePad = null;
            SetPaused(true);
        }

        void NewScreen(Mode next)
        {
            lifetime?.Cancel();
            lifetime?.Dispose();
            lifetime = new CancellationTokenSource();
            mode = next;
            paused = busy = finished = dashQueued = submitBusy = false;
            accumulator = 0;
            choice = -1;
            touch = Vector2.zero;
            activePad = null;
            submitAgain = null;
            arena.ResetView();
        }

        void ShowMenu()
        {
            NewScreen(Mode.Menu);
            sim = new Sim(NewSeed(), false);
            arena.SetMusic(false);
            SetScreen(menu);
            _ = RefreshBoard(lifetime.Token);
        }

        async Task StartRun()
        {
            NewScreen(Mode.Play);
            var ct = lifetime.Token;
            busy = true;
            SetScreen(hud);
            SetNotice("Connecting…");
            try
            {
                var outcome = await api.IssueAsync(ct);
                if (ct.IsCancellationRequested) return;
                var issued = outcome.Run;
                bool ranked = issued != null && issued.simVersion == Defs.SimVersion && issued.segmentFrames == Defs.SegmentFrames;
                runId = ranked ? issued.runId : null;
                seed = ranked ? issued.seed : NewSeed();
                sim = new Sim(seed, true, ranked ? issued.segmentFrames : 0);
                recorded = new InputRecorder();
                segment = new InputRecorder();
                seeds.Clear();
                SetNotice(ranked ? "Ranked" : outcome.Kind == IssueKind.Quota ? "Ranked limit reached • playing offline" : "Offline • scores stay on this device");
            }
            catch (OperationCanceledException) { }
            finally { if (!ct.IsCancellationRequested) busy = false; }
        }

        static int NewSeed() => UnityEngine.Random.Range(1, int.MaxValue);

        void OnApplicationPause(bool inactive)
        {
            if (inactive && mode == Mode.Play && !finished) SetPaused(true);
        }

        void SetPaused(bool value)
        {
            if (mode != Mode.Play || finished) return;
            paused = value;
            touch = Vector2.zero;
            dashQueued = false;
            choice = -1;
            moveZone.gameObject.SetActive(!value);
            accumulator = 0;
            pausePanel.SetActive(value);
            if (value) choicePanel.SetActive(false);
        }

        void Update()
        {
            UpdateSafeArea();
            PollControls();
            if (sim == null) return;
            if (!paused && !busy && !finished && mode != Mode.Menu)
            {
                accumulator += Mathf.Min(Time.unscaledDeltaTime, 0.1f) * (mode == Mode.Replay ? replaySpeed : 1);
                int budget = mode == Mode.Replay ? 24 : 6;
                while (accumulator >= Defs.DT && budget-- > 0)
                {
                    if (!Advance()) { accumulator = 0; break; }
                    accumulator -= (float)Defs.DT;
                    if (finished || busy) break;
                }
            }
            arena.SetMusic(mode != Mode.Menu && !paused && !busy && !finished && sim.Phase == Phase.Playing);
            arena.Render(sim, paused || busy || finished || sim.Phase == Phase.LevelUp ? 1 : Mathf.Clamp01(accumulator / (float)Defs.DT));
            if (mode != Mode.Menu && !finished) UpdateHud(sim, mode == Mode.Replay, replaySpeed, paused);
        }

        bool Advance()
        {
            if (sim.SegmentDue)
            {
                if (mode == Mode.Replay)
                {
                    if (replaySeed >= replaySeeds.Length) { FinishReplay(); return false; }
                    sim.BeginSegment(replaySeeds[replaySeed++]);
                }
                else if (runId == null) BeginSegment(NewSeed());
                else { _ = Synchronize(lifetime.Token); return false; }
            }
            InputFrame frame;
            if (mode == Mode.Replay)
            {
                if (replayRemaining == 0)
                {
                    if (replayOffset + 1 >= replayInputs.Length) { FinishReplay(); return false; }
                    replayRemaining = replayInputs[replayOffset + 1];
                    replayOffset += 2;
                }
                frame = InputFrame.Decode(replayInputs[replayOffset - 2]);
                replayRemaining--;
            }
            else
            {
                if (sim.Phase == Phase.LevelUp)
                {
                    if (choice < 0 || choice >= sim.Choices.Count) { choice = -1; return false; }
                    frame = new InputFrame { Choice = choice };
                }
                else
                {
                    var movement = ReadMovement();
                    frame = new InputFrame { Mx = (int)movement.x, My = (int)movement.y, Dash = dashQueued, Choice = -1 };
                }
                choice = -1;
                dashQueued = false;
                int code = frame.Encode();
                recorded.Push(code);
                if (runId != null) segment.Push(code);
            }
            sim.Step(frame);
            arena.PlayEvents(sim);
            if (sim.Phase == Phase.Won || sim.Phase == Phase.Dead)
            {
                if (mode == Mode.Replay) FinishReplay();
                else FinishRun();
            }
            return true;
        }

        void BeginSegment(int next)
        {
            sim.BeginSegment(next);
            seeds.Add(next);
            segment = new InputRecorder();
        }

        async Task Synchronize(CancellationToken ct)
        {
            busy = true;
            try
            {
                var reply = await api.CommitAsync(runId, sim.Segment, segment.Runs.ToArray(), false, ct);
                if (ct.IsCancellationRequested) return;
                if (reply != null && reply.HasNext && reply.next.index == sim.Segment + 1) BeginSegment(reply.next.seed);
                else
                {
                    runId = null;
                    BeginSegment(NewSeed());
                    SetNotice("Ranked connection ended • continuing offline");
                }
            }
            catch (OperationCanceledException) { }
            finally { if (!ct.IsCancellationRequested) { busy = false; accumulator = 0; } }
        }

        void FinishRun()
        {
            finished = true;
            var value = sim.Result();
            lastReplay = new ReplayData { seed = seed, simVersion = sim.SegmentFrames == 0 ? Defs.LegacySimVersion : Defs.SimVersion, segmentSeeds = seeds.ToArray(), inputs = recorded.Runs.ToArray(), score = value.Score };
            int best = Mathf.Max(PlayerPrefs.GetInt("last-ember-best"), value.Score);
            PlayerPrefs.SetInt("last-ember-best", best);
            PlayerPrefs.Save();
            SetScreen(resultPanel);
            SetResult(value.Won ? "ABYSSAL CORE DESTROYED" : "THE EMBER WENT OUT", value, $"Best  {best:N0}", true);
            if (runId == null) { SetResultNotice("Offline result • not ranked", false); return; }
            string id = runId;
            int index = sim.Segment;
            int[] final = segment.Runs.ToArray();
            string name = PlayerName();
            var finalState = new FinalSubmitState();
            submitAgain = async ct =>
            {
                var reply = await api.SubmitFinalAsync(id, index, final, name, value.Score, value.Checksum, finalState, ct);
                if (ct.IsCancellationRequested) return;
                if (reply != null && reply.ok)
                {
                    submitAgain = null;
                    SetResultNotice($"Verified • rank {reply.rank}", false);
                }
                else ShowSubmitFailure(reply?.error);
            };
            _ = SubmitResult();
        }

        void ShowSubmitFailure(string error)
        {
            bool retry = string.IsNullOrEmpty(error) || RankedErrors.IsRetryable(error) || error == RankedErrors.AlreadySubmitted;
            if (!retry) submitAgain = null;
            SetResultNotice(retry ? "Could not confirm the record. Try again." : $"Record rejected: {error}", retry);
        }

        async Task SubmitResult()
        {
            if (submitBusy || submitAgain == null) return;
            var ct = lifetime.Token;
            submitBusy = true;
            SetResultNotice("Verifying replay…", false);
            try { await submitAgain(ct); }
            catch (OperationCanceledException) { }
            finally { if (!ct.IsCancellationRequested) submitBusy = false; }
        }

        async Task OpenReplay(string id)
        {
            var ct = lifetime.Token;
            try
            {
                var replay = await api.ReplayAsync(id, ct);
                if (!ct.IsCancellationRequested && !StartReplay(replay)) SetNotice("Replay unavailable");
            }
            catch (OperationCanceledException) { }
        }

        bool StartReplay(ReplayData replay)
        {
            if (replay == null || Defs.SegmentFramesFor(replay.simVersion) < 0 || replay.inputs == null || replay.inputs.Length == 0) return false;
            NewScreen(Mode.Replay);
            replayInputs = replay.inputs;
            replaySeeds = replay.segmentSeeds ?? Array.Empty<int>();
            replaySeed = replayOffset = replayRemaining = 0;
            replaySpeed = 1;
            sim = new Sim(replay.seed, true, Defs.SegmentFramesFor(replay.simVersion));
            SetScreen(hud);
            SetNotice("Replay");
            return true;
        }

        void FinishReplay()
        {
            finished = true;
            SetScreen(resultPanel);
            SetResult("REPLAY ENDED", sim.Result(), "", false);
            SetResultNotice("", false);
        }

        async Task RefreshBoard(CancellationToken ct)
        {
            PopulateBoard(null);
            try
            {
                var board = await api.BoardAsync(ct);
                if (!ct.IsCancellationRequested) PopulateBoard(board);
            }
            catch (OperationCanceledException) { }
        }

        void PollControls()
        {
            var k = Keyboard.current;
            var p = Gamepad.current;
            bool samePad = p != null && p == previousPad;
            bool newDash = p != null && (p.buttonSouth.isPressed || p.rightShoulder.isPressed || p.rightTrigger.isPressed);
            bool newPause = p != null && p.startButton.isPressed;
            bool newX = p != null && p.buttonWest.isPressed, newY = p != null && p.buttonNorth.isPressed, newB = p != null && p.buttonEast.isPressed;
            if (mode == Mode.Play && !finished)
            {
                bool pausePressed = samePad && newPause && !padPause;
                if (pausePressed) activePad = p;
                if (k?.escapeKey.wasPressedThisFrame == true || pausePressed) SetPaused(!paused);
                if (!paused && !busy)
                {
                    bool dashPressed = samePad && newDash && !padDash;
                    if (dashPressed) activePad = p;
                    dashQueued |= k?.spaceKey.wasPressedThisFrame == true || dashPressed;
                    if (sim?.Phase == Phase.LevelUp)
                    {
                        int padChoice = !samePad ? -1 : newX && !padX ? 0 : newY && !padY ? 1 : newB && !padB ? 2 : -1;
                        if (padChoice >= 0) activePad = p;
                        if (k?.digit1Key.wasPressedThisFrame == true || padChoice == 0) choice = 0;
                        else if (k?.digit2Key.wasPressedThisFrame == true || padChoice == 1) choice = 1;
                        else if (k?.digit3Key.wasPressedThisFrame == true || padChoice == 2) choice = 2;
                    }
                }
            }
            else if (mode == Mode.Replay && k?.escapeKey.wasPressedThisFrame == true) ShowMenu();
            padDash = newDash; padPause = newPause; padX = newX; padY = newY; padB = newB;
            previousPad = p;
        }

        Vector2 ReadMovement()
        {
            var k = Keyboard.current;
            if (k != null)
            {
                var keys = new Vector2((k.dKey.isPressed || k.rightArrowKey.isPressed ? 1 : 0) - (k.aKey.isPressed || k.leftArrowKey.isPressed ? 1 : 0), (k.sKey.isPressed || k.downArrowKey.isPressed ? 1 : 0) - (k.wKey.isPressed || k.upArrowKey.isPressed ? 1 : 0));
                if (keys != Vector2.zero) return keys;
            }
            var pad = Gamepad.current;
            if (pad != null)
            {
                var axes = pad.dpad.ReadValue();
                if (axes == Vector2.zero) axes = pad.leftStick.ReadValue();
                if (axes.sqrMagnitude >= 0.12f)
                {
                    activePad = pad;
                    return Quantize(new Vector2(axes.x, -axes.y));
                }
            }
            return touch;
        }

        static Vector2 Quantize(Vector2 v)
        {
            float threshold = v.magnitude * 0.38f;
            return new Vector2(Mathf.Abs(v.x) > threshold ? Mathf.Sign(v.x) : 0, Mathf.Abs(v.y) > threshold ? Mathf.Sign(v.y) : 0);
        }
    }
}
