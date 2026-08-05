import { homeCase } from "./shared.mjs";

/* Canvas drawing helper: returns a drawAt function that maps canvas-relative
   fractions (0–1) to viewport coordinates for drag. This adapts to the
   actual rendered canvas size instead of assuming fixed 400×300. */
function canvasSetup() {
  return `
    const canvasRect = await page.evaluate(\`(() => {
      const c = document.querySelector("#draw-canvas");
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    })()\`);
    assert(canvasRect.w > 0 && canvasRect.h > 0, "canvas has non-zero rendered dimensions");
    function drawAt(fx, fy) {
      return [Math.round(canvasRect.left + canvasRect.w * fx), Math.round(canvasRect.top + canvasRect.h * fy)];
    }
  `;
}

/* Returns a JS expression string that checks if pixel at canvas-relative
   fraction (fx, fy) has non-zero alpha (something was drawn there).
   Converts fraction to integer pixel coordinates at evaluation time. */
function pixelDrawn(fx, fy) {
  return (
    `(() => { const c = document.querySelector("#draw-canvas"); ` +
    `const ctx = c.getContext("2d"); ` +
    `const d = ctx.getImageData(` +
    `Math.round(${fx} * c.width), Math.round(${fy} * c.height), 1, 1).data; ` +
    `return d[3] > 0; })()`
  );
}

export const canvasCases = [
  {
    name: "canvas draw single stroke",
    body: homeCase(`
      ${canvasSetup()}

      /* Draw a horizontal line across the middle of the canvas. */
      await page.mouse.drag([drawAt(0.05, 0.5), drawAt(0.5, 0.5), drawAt(0.95, 0.5)], { delay: 10 });

      await waitForJsValue("window.__fixtureState.canvasStrokes", 1, "single drag creates one stroke");
      await waitForJsCondition("window.__fixtureState.canvasPoints >= 3", "stroke has at least 3 points");
      assertEqual(
        await page.evaluate(() => window.__fixtureState.canvasDrawing),
        false,
        "canvas drawing state resets after mouseup"
      );

      /* Verify pixels were drawn at three positions along the stroke path. */
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.15, 0.5))}), "pixels drawn at stroke start region");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.5, 0.5))}), "pixels drawn at stroke midpoint");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.85, 0.5))}), "pixels drawn at stroke end region");

      /* Verify the last recorded point is near the end of the stroke. */
      const lastPoint = await page.evaluate(() => window.__fixtureState.canvasLastPoint);
      const lastFrac = lastPoint.x / await page.evaluate(() => document.querySelector('#draw-canvas').width);
      assert(lastFrac > 0.8, "canvas last point x is near stroke end");
    `),
  },
  {
    name: "canvas draw multiple strokes",
    body: homeCase(`
      ${canvasSetup()}

      /* Stroke 1: horizontal line in the upper third. */
      await page.mouse.drag([drawAt(0.1, 0.25), drawAt(0.5, 0.25), drawAt(0.9, 0.25)], { delay: 15 });
      await waitForJsValue("window.__fixtureState.canvasStrokes", 1, "first stroke registered");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.5, 0.25))}), "pixels drawn on first stroke path");

      /* Stroke 2: horizontal line in the lower third. */
      await page.waitForTimeout(100);
      await page.mouse.drag([drawAt(0.1, 0.75), drawAt(0.5, 0.75), drawAt(0.9, 0.75)], { delay: 15 });
      await waitForJsValue("window.__fixtureState.canvasStrokes", 2, "second stroke registered");
      await waitForJsCondition("window.__fixtureState.canvasPoints >= 6", "two strokes have at least 6 points total");

      /* Verify pixels on second stroke — check a small area around the expected point. */
      const secondStrokeFound = await page.evaluate(\`(() => {
        const c = document.querySelector("#draw-canvas");
        const ctx = c.getContext("2d");
        const cx = Math.round(0.5 * c.width);
        const cy = Math.round(0.75 * c.height);
        for (let dy = -5; dy <= 5; dy++) {
          const d = ctx.getImageData(cx, cy + dy, 1, 1).data;
          if (d[3] > 0) return true;
        }
        return false;
      })()\`);
      assert(secondStrokeFound, "pixels drawn on second stroke path");

      /* Verify a point between the strokes has no pixels (strokes don't bleed). */
      const gapAlpha = await page.evaluate(
        "return document.querySelector('#draw-canvas').getContext('2d').getImageData(" +
        "Math.round(document.querySelector('#draw-canvas').width / 2), " +
        "Math.round(document.querySelector('#draw-canvas').height / 2), 1, 1).data[3]"
      );
      assertEqual(gapAlpha, 0, "no pixels between the two strokes at the gap");

      /* Stroke 3: vertical line. */
      await page.waitForTimeout(100);
      await page.mouse.drag([drawAt(0.3, 0.1), drawAt(0.3, 0.5), drawAt(0.3, 0.9)], { delay: 15 });
      await waitForJsValue("window.__fixtureState.canvasStrokes", 3, "third stroke registered");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.3, 0.5))}), "pixels drawn on vertical stroke");
    `),
  },
  {
    name: "canvas draw zigzag path",
    body: homeCase(`
      ${canvasSetup()}

      /* Draw a zigzag with 5 points: left → right-up → left-down → right-up → right. */
      await page.mouse.drag(
        [drawAt(0.08, 0.5), drawAt(0.3, 0.17), drawAt(0.5, 0.83), drawAt(0.75, 0.17), drawAt(0.93, 0.5)],
        { delay: 15 }
      );

      await waitForJsValue("window.__fixtureState.canvasStrokes", 1, "zigzag is a single stroke");
      await waitForJsCondition("window.__fixtureState.canvasPoints >= 5", "zigzag has at least 5 points");

      /* Verify pixels at multiple segments of the zigzag path. */
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.08, 0.5))}), "pixels at zigzag start");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.3, 0.17))}), "pixels at zigzag peak 1");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.5, 0.83))}), "pixels at zigzag valley");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.75, 0.17))}), "pixels at zigzag peak 2");
      assert(await page.evaluate("return " + ${JSON.stringify(pixelDrawn(0.93, 0.5))}), "pixels at zigzag end");

      /* Verify drawing is complete. */
      assertEqual(
        await page.evaluate(() => window.__fixtureState.canvasDrawing),
        false,
        "zigzag drawing state is complete"
      );
    `),
  },
];
