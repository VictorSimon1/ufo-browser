import { homeCase } from "./shared.mjs";

export const interactionsCases = [
  {
    name: "pointer events handler tracking",
    body: homeCase(`
      /* Pointer Events may not be generated from CDP Input.dispatchMouseEvent
         in the ego-lite browser. Simulate the full pointer event lifecycle via
         JS to verify the fixture handlers and state tracking work correctly. */

      const pointerResult = await page.evaluate(\`(() => {
        const area = document.querySelector("#pointer-area");
        const rect = area.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const common = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", clientX: cx, clientY: cy };

        area.dispatchEvent(new PointerEvent("pointerenter", { ...common, pressure: 0 }));
        area.dispatchEvent(new PointerEvent("pointermove", { ...common, pressure: 0 }));
        area.dispatchEvent(new PointerEvent("pointerdown", { ...common, pressure: 0.5 }));
        area.dispatchEvent(new PointerEvent("pointerup", { ...common, pressure: 0 }));
        area.dispatchEvent(new PointerEvent("pointerleave", { ...common, pressure: 0 }));

        return {
          types: window.__fixtureState.pointerEventTypes.slice(),
          downCount: window.__fixtureState.pointerDownCount,
          moveCount: window.__fixtureState.pointerMoveCount,
          lastType: window.__fixtureState.lastPointerType,
          lastPressure: window.__fixtureState.lastPointerPressure,
        };
      })()\`);

      assertIncludes(pointerResult.types.join(","), "pointerenter", "pointerenter tracked in event types");
      assertIncludes(pointerResult.types.join(","), "pointerdown", "pointerdown tracked in event types");
      assertIncludes(pointerResult.types.join(","), "pointerup", "pointerup tracked in event types");
      assertIncludes(pointerResult.types.join(","), "pointerleave", "pointerleave tracked in event types");
      assertEqual(pointerResult.downCount, 1, "pointerdown counted exactly once");
      assert(pointerResult.moveCount >= 1, "pointermove counted at least once");
      assertEqual(pointerResult.lastType, "mouse", "pointer type is mouse");
    `),
  },
  {
    name: "pointer events pressure tracking",
    body: homeCase(`
      /* Verify that pressure values are tracked correctly across different
         pointer event phases (hover=0, active=0.5). */

      const pressureResult = await page.evaluate(\`(() => {
        const area = document.querySelector("#pointer-area");
        const rect = area.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const common = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", clientX: cx, clientY: cy };

        /* Hover: pressure should be 0. */
        area.dispatchEvent(new PointerEvent("pointermove", { ...common, pressure: 0 }));
        const hoverPressure = window.__fixtureState.lastPointerPressure;

        /* Active press: pressure should be 0.5. */
        area.dispatchEvent(new PointerEvent("pointerdown", { ...common, pressure: 0.5 }));
        const activePressure = window.__fixtureState.lastPointerPressure;

        return { hoverPressure, activePressure, count: window.__fixtureState.pointerDownCount };
      })()\`);

      assertEqual(pressureResult.hoverPressure, 0, "hover pressure is 0");
      assertEqual(pressureResult.activePressure, 0.5, "active pointer pressure is 0.5");
      assertEqual(pressureResult.count, 1, "one pointerdown counted");
    `),
  },
  {
    name: "html5 dnd simulate drop via js",
    body: homeCase(`
      /* HTML5 DnD requires browser-native drag initiation that CDP cannot trigger.
         Simulate the full event sequence via JS to verify the fixture handlers
         and state tracking work correctly. */

      const dndResult = await page.evaluate(\`(() => {
        const source = document.querySelector("#dnd-source");
        const target = document.querySelector("#dnd-target");
        const dt = new DataTransfer();

        source.dispatchEvent(new DragEvent("dragstart", {
          bubbles: true, cancelable: true, dataTransfer: dt,
        }));

        dt.dropEffect = "move";
        target.dispatchEvent(new DragEvent("dragover", {
          bubbles: true, cancelable: true, dataTransfer: dt,
        }));

        const hasDragOver = target.classList.contains("drag-over");

        target.dispatchEvent(new DragEvent("drop", {
          bubbles: true, cancelable: true, dataTransfer: dt,
        }));

        source.dispatchEvent(new DragEvent("dragend", {
          bubbles: true, cancelable: true, dataTransfer: dt,
        }));

        return {
          dndDropped: window.__fixtureState.dndDropped,
          dndData: window.__fixtureState.dndData,
          hasDragOver,
          targetText: target.textContent,
        };
      })()\`);

      assert(dndResult.dndDropped, "drop handler set dndDropped to true");
      assertEqual(dndResult.dndData, "dnd-payload", "dataTransfer carried the payload");
      assert(dndResult.hasDragOver, "dragover added drag-over class to target");
      assertEqual(dndResult.targetText, "Dropped!", "target text updated on drop");
    `),
  },
  {
    name: "html5 dnd drag cancel",
    body: homeCase(`
      /* Simulate a cancelled drag: dragstart fires but no drop target receives
         the drop event, then dragend fires. */

      await page.evaluate(\`(() => {
        const source = document.querySelector("#dnd-source");
        const dt = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", {
          bubbles: true, cancelable: true, dataTransfer: dt,
        }));
        source.dispatchEvent(new DragEvent("dragend", {
          bubbles: true, cancelable: true, dataTransfer: dt,
        }));
      })()\`);

      assertEqual(
        await page.evaluate(() => window.__fixtureState.dndDropped),
        false,
        "cancelled drag leaves dndDropped as false"
      );
      const statusText = await page.evaluate(() => document.querySelector('#dnd-status').textContent);
      assertIncludes(statusText, "cancelled", "dnd status shows drag cancelled");
    `),
  },
];
