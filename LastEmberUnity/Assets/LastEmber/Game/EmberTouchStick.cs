using System;
using UnityEngine;
using UnityEngine.EventSystems;

namespace LastEmber.UnityClient
{
    public sealed class EmberTouchStick : MonoBehaviour, IPointerDownHandler, IDragHandler, IPointerUpHandler, ICancelHandler
    {
        const float Radius = 47;
        const float DeadZone = 12;
        int pointer = int.MinValue;
        Vector2 origin;
        RectTransform zone, ring, knob;
        Action<Vector2> changed;

        public void Bind(Action<Vector2> onChanged, RectTransform rect)
        {
            zone = rect;
            changed = onChanged;
            ring = Disc(rect, "StickOrigin", Radius * 2, new Color(.55f, .68f, 1, .2f));
            ring.anchorMin = ring.anchorMax = rect.pivot;
            knob = Disc(ring, "StickKnob", 36, new Color(.87f, .92f, 1, .75f));
            ring.gameObject.SetActive(false);
        }

        public void OnPointerDown(PointerEventData e)
        {
            if (pointer != int.MinValue || e.button != PointerEventData.InputButton.Left) return;
            if (!RectTransformUtility.ScreenPointToLocalPointInRectangle(zone, e.position, e.pressEventCamera, out origin)) return;
            pointer = e.pointerId;
            ring.anchoredPosition = origin;
            knob.anchoredPosition = Vector2.zero;
            ring.gameObject.SetActive(true);
        }

        public void OnDrag(PointerEventData e)
        {
            if (pointer != e.pointerId || !RectTransformUtility.ScreenPointToLocalPointInRectangle(zone, e.position, e.pressEventCamera, out var at)) return;
            var delta = at - origin;
            knob.anchoredPosition = Vector2.ClampMagnitude(delta, Radius);
            changed(delta.sqrMagnitude < DeadZone * DeadZone ? Vector2.zero : delta);
        }

        public void OnPointerUp(PointerEventData e) { if (e.pointerId == pointer) ResetStick(); }
        public void OnCancel(BaseEventData _) => ResetStick();
        void OnDisable() => ResetStick();

        void ResetStick()
        {
            pointer = int.MinValue;
            if (ring != null) ring.gameObject.SetActive(false);
            changed?.Invoke(Vector2.zero);
        }

        static RectTransform Disc(Transform parent, string name, float size, Color color)
        {
            var node = new GameObject(name, typeof(RectTransform), typeof(UnityEngine.UI.Image));
            var rect = node.GetComponent<RectTransform>();
            rect.SetParent(parent, false);
            rect.sizeDelta = new Vector2(size, size);
            var image = node.GetComponent<UnityEngine.UI.Image>();
            image.color = color;
            image.raycastTarget = false;
            return rect;
        }
    }
}
