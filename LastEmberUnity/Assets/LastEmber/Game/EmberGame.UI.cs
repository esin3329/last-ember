using System;
using LastEmber.Core;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.UI;

namespace LastEmber.UnityClient
{
    public sealed partial class EmberGame
    {
        static readonly Color Ink = new Color32(233, 236, 255, 255);
        static readonly Color Dim = new Color32(166, 174, 203, 255);
        static readonly Color Ember = new Color32(255, 181, 78, 255);
        static readonly Color Panel = new Color32(17, 20, 37, 247);
        static readonly string[] UpgradeNames = { "Ember Bolt", "Orbit Blades", "Flash Nova", "Chain Lightning", "Might", "Haste", "Swiftness", "Vitality", "Magnet", "Regeneration", "Sun Lance", "Tempest", "Bloom", "Thunder" };
        RectTransform safe, menu, hud, resultPanel, moveZone;
        GameObject choicePanel, pausePanel;
        TMP_Text clockText, vitals, notice, summary, resultNotice, resultTitle, boardTip;
        TMP_Text[] choiceLabels = new TMP_Text[3];
        UnityEngine.UI.Button[] choices = new UnityEngine.UI.Button[3];
        UnityEngine.UI.Button[] boardRows = new UnityEngine.UI.Button[5];
        UnityEngine.UI.Button retryButton, watchButton, replaySpeedButton, dashButton, pauseButton;
        TMP_InputField nameField;
        BoardEntry[] leaderboard;
        Rect lastSafe;
        Vector2Int lastScreen;
        int shownSecond = -1, shownLevel = -1, shownScore = -1, shownXp = -1, shownHp = -1, shownMaxHp = -1, shownDash = -1;

        void BuildUi()
        {
            if (font == null) font = TMP_Settings.defaultFontAsset;
            if (font == null) font = TMP_FontAsset.CreateFontAsset(Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"));
            var canvas = new GameObject("EmberCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvas.transform.SetParent(transform, false);
            canvas.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
            var scale = canvas.GetComponent<CanvasScaler>();
            scale.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scale.referenceResolution = new Vector2(432, 900);
            scale.screenMatchMode = CanvasScaler.ScreenMatchMode.Expand;
            if (FindAnyObjectByType<EventSystem>() == null)
            {
                var events = new GameObject("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
                events.transform.SetParent(transform, false);
                events.GetComponent<InputSystemUIInputModule>().AssignDefaultActions();
            }
            safe = RectNode(canvas.transform, "SafeArea", Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
            menu = ScreenPanel("Menu");
            hud = ScreenPanel("HUD");
            resultPanel = ScreenPanel("Result");

            var menuBody = Box(menu, "TitleAndLeaderboard", new Vector2(.07f, .08f), new Vector2(.93f, .92f));
            var title = Label(menuBody, "Title", 48, "LAST EMBER", Ember);
            Anchor(title.rectTransform, .76f, .94f);
            Anchor(Label(menuBody, "Description", 19, "Survive three minutes. Destroy the Abyssal Core.", Ink).rectTransform, .66f, .78f);
            var edit = RectNode(menuBody, "PlayerName", new Vector2(.08f,.60f), new Vector2(.92f,.66f), Vector2.zero, Vector2.zero);
            edit.gameObject.AddComponent<UnityEngine.UI.Image>().color = new Color32(31, 35, 59, 255);
            nameField = edit.gameObject.AddComponent<TMP_InputField>();
            nameField.targetGraphic = edit.GetComponent<UnityEngine.UI.Image>();
            nameField.textViewport = RectNode(edit, "Viewport", Vector2.zero, Vector2.one, new Vector2(9, 2), new Vector2(-9, -2));
            nameField.textComponent = Label(nameField.textViewport, "Name", 20, "", Ink);
            nameField.placeholder = Label(nameField.textViewport, "Placeholder", 20, "Player name", Dim);
            nameField.characterLimit = 12;
            nameField.text = PlayerPrefs.GetString("last-ember-name");
            Anchor(Button(menuBody, "Play", "PLAY", () => { PlayerPrefs.SetString("last-ember-name", nameField.text); _ = StartRun(); }, true).GetComponent<RectTransform>(), .49f, .58f);
            Anchor(Label(menuBody, "Leaderboard", 22, "LEADERBOARD", Ember).rectTransform, .42f, .48f);
            boardTip = Label(menuBody, "BoardStatus", 16, "Connecting…", Dim);
            Anchor(boardTip.rectTransform, .35f, .42f);
            for (int i = 0; i < boardRows.Length; i++)
            {
                int index = i;
                boardRows[i] = Button(menuBody, "Replay" + i, "", () => { if (leaderboard != null && index < leaderboard.Length) _ = OpenReplay(leaderboard[index].runId); });
                Anchor(boardRows[i].GetComponent<RectTransform>(), .302f - i * .052f, .35f - i * .052f);
            }
            soundButton = Button(menuBody, "Sound", "Sound: On", ToggleSound);
            Anchor(soundButton.GetComponent<RectTransform>(), .02f, .08f);

            var top = Box(hud, "StatusBar", new Vector2(.02f,.865f), new Vector2(.98f,.985f));
            clockText = Label(top, "Clock", 26, "0:00", Ember);
            Anchor(clockText.rectTransform, .56f, 1);
            vitals = Label(top, "Vitals", 18, "", Ink);
            Anchor(vitals.rectTransform, 0, .58f);
            notice = Label(hud, "Notice", 17, "", Dim);
            Anchor(notice.rectTransform, .80f, .863f);
            moveZone = RectNode(hud, "Movement", Vector2.zero, new Vector2(1,.79f), Vector2.zero, Vector2.zero);
            var touchImage = moveZone.gameObject.AddComponent<UnityEngine.UI.Image>();
            touchImage.color = new Color(0, 0, 0, .001f);
            var stick = moveZone.gameObject.AddComponent<EmberTouchStick>();
            stick.Bind(value => touch = Quantize(new Vector2(value.x, -value.y)), moveZone);
            dashButton = Button(hud, "Dash", "DASH", () => { if (!paused && mode == Mode.Play) dashQueued = true; }, true);
            AnchorControl(dashButton.GetComponent<RectTransform>(), new Vector2(1, 0), new Vector2(-20, 34), new Vector2(104, 76));
            pauseButton = Button(hud, "Pause", "II", () => SetPaused(true));
            AnchorControl(pauseButton.GetComponent<RectTransform>(), new Vector2(1, 1), new Vector2(-18, -136), new Vector2(52, 46));
            replaySpeedButton = Button(hud, "ReplaySpeed", "1×", () => { replaySpeed = replaySpeed >= 8 ? 1 : replaySpeed * 2; });
            AnchorControl(replaySpeedButton.GetComponent<RectTransform>(), new Vector2(1, 0), new Vector2(-20, 34), new Vector2(86, 60));
            var leaveReplay = Button(hud, "LeaveReplay", "Menu", ShowMenu);
            AnchorControl(leaveReplay.GetComponent<RectTransform>(), Vector2.zero, new Vector2(20,34), new Vector2(86,60));
            replayMenuButton = leaveReplay.gameObject;

            var picking = Box(hud, "ChooseUpgrade", new Vector2(.07f,.24f), new Vector2(.93f,.72f));
            choicePanel = picking.gameObject;
            Anchor(Label(picking, "ChooseTitle", 25, "CHOOSE AN UPGRADE", Ember).rectTransform, .79f, 1);
            for (int i = 0; i < choices.Length; i++)
            {
                int index = i;
                choices[i] = Button(picking, "Upgrade" + i, "", () => choice = index);
                choiceLabels[i] = choices[i].GetComponentInChildren<TMP_Text>();
                Anchor(choices[i].GetComponent<RectTransform>(), .56f - .25f * i, .75f - .25f * i);
            }
            var overlay = Box(hud, "PausePanel", new Vector2(.12f,.32f), new Vector2(.88f,.67f));
            pausePanel = overlay.gameObject;
            Anchor(Label(overlay, "PauseTitle", 32, "PAUSED", Ember).rectTransform, .69f, .98f);
            Anchor(Button(overlay, "Resume", "Resume", () => SetPaused(false), true).GetComponent<RectTransform>(), .39f, .64f);
            Anchor(Button(overlay, "Menu", "Main menu", ShowMenu).GetComponent<RectTransform>(), .11f, .35f);

            var details = Box(resultPanel, "ResultDetails", new Vector2(.08f,.18f), new Vector2(.92f,.82f));
            resultTitle = Label(details, "ResultTitle", 32, "", Ember);
            Anchor(resultTitle.rectTransform, .76f, .96f);
            summary = Label(details, "Summary", 23, "", Ink);
            Anchor(summary.rectTransform, .50f, .77f);
            resultNotice = Label(details, "ResultStatus", 17, "", Dim);
            Anchor(resultNotice.rectTransform, .40f, .51f);
            retryButton = Button(details, "Resubmit", "Resubmit record", () => _ = SubmitResult());
            Anchor(retryButton.GetComponent<RectTransform>(), .30f, .40f);
            newRunButton = Button(details, "Restart", "Play again", () => _ = StartRun(), true);
            Anchor(newRunButton.GetComponent<RectTransform>(), .19f, .29f);
            watchButton = Button(details, "Watch", "Watch last run", () => StartReplay(lastReplay));
            Anchor(watchButton.GetComponent<RectTransform>(), .09f, .185f);
            Anchor(Button(details, "Menu", "Main menu", ShowMenu).GetComponent<RectTransform>(), 0, .085f);
            UpdateSafeArea();
        }

        GameObject replayMenuButton;
        UnityEngine.UI.Button newRunButton, soundButton;

        void ToggleSound()
        {
            arena.Muted = !arena.Muted;
            soundButton.GetComponentInChildren<TMP_Text>().text = arena.Muted ? "Sound: Off" : "Sound: On";
        }

        void SetScreen(RectTransform screen)
        {
            menu.gameObject.SetActive(screen == menu);
            hud.gameObject.SetActive(screen == hud);
            resultPanel.gameObject.SetActive(screen == resultPanel);
            pausePanel.SetActive(false);
            choicePanel.SetActive(false);
            shownSecond = shownLevel = shownScore = shownXp = shownHp = shownMaxHp = shownDash = -1;
            if (screen == hud)
            {
                bool replay = mode == Mode.Replay;
                moveZone.gameObject.SetActive(!replay);
                dashButton.gameObject.SetActive(!replay);
                pauseButton.gameObject.SetActive(!replay);
                replaySpeedButton.gameObject.SetActive(replay);
                replayMenuButton.SetActive(replay);
            }
        }

        void UpdateSafeArea()
        {
            var size = new Vector2Int(Screen.width, Screen.height);
            var area = Screen.safeArea;
            if (lastScreen == size && lastSafe == area || size.x <= 0 || size.y <= 0) return;
            lastScreen = size;
            lastSafe = area;
            safe.anchorMin = new Vector2(area.xMin / size.x, area.yMin / size.y);
            safe.anchorMax = new Vector2(area.xMax / size.x, area.yMax / size.y);
        }

        void UpdateHud(Sim state, bool replay, int speed, bool isPaused)
        {
            int seconds = state.Tick / Defs.TickRate;
            if (shownSecond != seconds) { shownSecond = seconds; clockText.text = $"{seconds / 60}:{seconds % 60:00}   {(state.BossSpawned ? "BOSS" : "SURVIVE")}"; }
            var p = state.Player;
            int hp = Mathf.CeilToInt((float)p.Hp), maxHp = Mathf.CeilToInt((float)p.MaxHp);
            if (shownLevel != p.Level || shownScore != state.Score || shownHp != hp || shownMaxHp != maxHp || shownXp != p.Xp)
            {
                shownLevel = p.Level; shownScore = state.Score; shownHp = hp; shownMaxHp = maxHp; shownXp = p.Xp;
                vitals.text = $"Lv {p.Level}  •  HP {hp}/{maxHp}  •  XP {p.Xp}/{p.XpNext}\nScore {state.Score:N0}   Kills {state.Kills:N0}";
            }
            if (replay) replaySpeedButton.GetComponentInChildren<TMP_Text>().SetText("{0}×", speed);
            else
            {
                int dash = (p.DashCd + 5) / 6;
                if (shownDash != dash)
                {
                    shownDash = dash;
                    dashButton.interactable = dash == 0;
                    dashButton.GetComponentInChildren<TMP_Text>().text = dash == 0 ? "DASH" : $"{dash / 10f:0.0}s";
                }
            }
            bool picking = !replay && !isPaused && state.Phase == Phase.LevelUp;
            if (choicePanel.activeSelf != picking) choicePanel.SetActive(picking);
            if (!picking) return;
            for (int i = 0; i < choices.Length; i++)
            {
                choices[i].gameObject.SetActive(i < state.Choices.Count);
                if (i >= state.Choices.Count) continue;
                int id = state.Choices[i];
                string name = id < UpgradeNames.Length ? UpgradeNames[id] : $"Upgrade {id}";
                choiceLabels[i].text = name;
            }
        }

        void SetNotice(string text) => notice.text = text;
        string PlayerName() => string.IsNullOrWhiteSpace(nameField.text) ? "Anonymous" : nameField.text.Trim();

        void SetResult(string title, RunResult value, string best, bool allowReplay)
        {
            resultTitle.text = title;
            summary.text = $"{value.Score:N0}\nLv {value.Level}   •   {value.Kills} kills\n{value.Ticks / 60} s   {best}";
            watchButton.gameObject.SetActive(allowReplay && lastReplay != null);
            newRunButton.gameObject.SetActive(allowReplay);
            retryButton.gameObject.SetActive(false);
        }

        void SetResultNotice(string text, bool retry)
        {
            resultNotice.text = text;
            retryButton.gameObject.SetActive(retry);
        }

        void PopulateBoard(BoardEntry[] list)
        {
            leaderboard = list;
            boardTip.text = list == null ? "No ranked server connected" : list.Length == 0 ? "No verified runs yet" : "Tap a record to replay";
            for (int i = 0; i < boardRows.Length; i++)
            {
                bool available = list != null && i < list.Length;
                boardRows[i].gameObject.SetActive(available);
                if (available) boardRows[i].GetComponentInChildren<TMP_Text>().text = $"#{list[i].rank}  {list[i].name}  •  {list[i].score:N0}  ▶";
            }
        }

        RectTransform ScreenPanel(string name) => RectNode(safe, name, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
        static RectTransform Box(RectTransform parent, string name, Vector2 min, Vector2 max)
        {
            var rect = RectNode(parent, name, min, max, Vector2.zero, Vector2.zero);
            var bg = rect.gameObject.AddComponent<UnityEngine.UI.Image>();
            bg.color = Panel;
            bg.raycastTarget = false;
            return rect;
        }

        UnityEngine.UI.Button Button(RectTransform parent, string name, string label, Action action, bool primary = false)
        {
            var rect = RectNode(parent, name, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
            var image = rect.gameObject.AddComponent<UnityEngine.UI.Image>();
            image.color = primary ? Ember : new Color32(43, 49, 75, 255);
            var button = rect.gameObject.AddComponent<UnityEngine.UI.Button>();
            button.targetGraphic = image;
            button.onClick.AddListener(() => action());
            Label(rect, "Label", 20, label, primary ? new Color32(38, 23, 10, 255) : Ink);
            return button;
        }

        TMP_Text Label(RectTransform parent, string name, int size, string content, Color color)
        {
            var rect = RectNode(parent, name, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
            var label = rect.gameObject.AddComponent<TextMeshProUGUI>();
            label.font = font;
            label.fontSize = size;
            label.text = content;
            label.color = color;
            label.alignment = TextAlignmentOptions.Center;
            label.raycastTarget = false;
            label.overflowMode = TextOverflowModes.Ellipsis;
            return label;
        }

        static RectTransform RectNode(Transform parent, string name, Vector2 min, Vector2 max, Vector2 offsetMin, Vector2 offsetMax)
        {
            var r = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
            r.SetParent(parent, false);
            r.anchorMin = min; r.anchorMax = max; r.offsetMin = offsetMin; r.offsetMax = offsetMax;
            return r;
        }

        static void Anchor(RectTransform r, float bottom, float top)
        {
            r.anchorMin = new Vector2(.06f, bottom); r.anchorMax = new Vector2(.94f, top);
            r.offsetMin = r.offsetMax = Vector2.zero;
        }

        static void AnchorControl(RectTransform r, Vector2 corner, Vector2 inset, Vector2 size)
        {
            r.anchorMin = r.anchorMax = corner;
            r.pivot = corner;
            r.anchoredPosition = inset;
            r.sizeDelta = size;
        }
    }
}
