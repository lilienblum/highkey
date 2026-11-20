import { useEffect, useRef } from "react";

// 4×4 Bayer threshold matrix normalised to (0, 1). Shared by every ordered-dither surface.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (value) => (value + 0.5) / 16,
);
// CSS pixels per dither pixel; matches the 2px screen tones in styles.css.
const CELL = 2;
// A deliberately low frame rate keeps the drift legible as stepped dither and costs almost nothing.
const FPS = 12;
// The field drifts on arrival and while the identity area is hovered, then holds still.
const ARRIVAL_MS = 6000;
const SETTLE_MS = 1200;
// The bloom fades out above the project picker so its label sits on plain sidebar ground.
const FADE_PX = 104;

type Palette = { orange: number; orangeBright: number; violet: number };

function readColor(context: CanvasRenderingContext2D, value: string) {
  context.fillStyle = "#000";
  context.fillStyle = value;
  const hex = String(context.fillStyle).replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) || 0);
}

function packed([r, g, b]: number[]) {
  // ImageData is RGBA in memory; a little-endian Uint32 view reads it as ABGR.
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function mix(a: number[], b: number[], amount: number) {
  return a.map((channel, index) => Math.round(channel * amount + b[index] * (1 - amount)));
}

function resolvePalette(context: CanvasRenderingContext2D): Palette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => readColor(context, styles.getPropertyValue(name).trim());
  const ground = token("--sidebar");
  const primary = token("--primary");
  const violet = token("--data-secondary");
  return {
    orange: packed(mix(primary, ground, 0.5)),
    orangeBright: packed(mix(primary, ground, 0.82)),
    violet: packed(mix(violet, ground, 0.55)),
  };
}

/**
 * Decorative ordered-dither field behind the sidebar identity: an orange and a violet bloom
 * drifting over a slow wave, quantised to the sidebar palette. It drifts for a few seconds on
 * arrival and while the identity area is hovered, then holds a still frame. Reduced motion only
 * ever draws the still frame.
 *
 * `top` (the sidebar) lights the field from its top edge and dissolves it downward. `band` (a
 * short header such as the account panel's) centres the blooms on the middle row and dissolves
 * them equally toward both edges, so a mark centred in the header sits in the field's middle.
 * `field` (a panel of its own) spreads larger blooms over the frame and dissolves its lower part
 * into the ground, where text can sit on plain ground. `drift="always"` keeps it moving while the
 * page is visible, still under reduced motion.
 */
export function DitherField({
  profile = "top",
  drift = "arrival",
}: {
  profile?: "top" | "band" | "field";
  drift?: "arrival" | "always";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const band = profile === "band";
    const field = profile === "field";
    const always = drift === "always";
    const canvas = canvasRef.current;
    const frame = canvas?.parentElement;
    const host = frame?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !frame || !host || !context) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const palette = resolvePalette(context);
    let width = 0;
    let height = 0;
    let columns = 0;
    let rows = 0;
    let image: ImageData | undefined;
    let pixels = new Uint32Array(0);
    // Field time only advances while animating, so each wake resumes where the drift stopped.
    let time = 0;
    let timer = 0;
    let last = 0;
    let until = 0;
    let hovering = false;

    const render = () => {
      if (!image || !columns || !rows) return;
      const reach = (field ? Math.max(width, height) * 0.5 : Math.max(width * 0.55, 96)) ** 2;
      const swell = field ? 0.12 : 0.09;
      const orangeX =
        width * (field ? 0.3 + 0.14 * Math.sin(time * 0.23) : 0.2 + 0.1 * Math.sin(time * 0.23));
      const orangeY =
        height *
        (field
          ? 0.42 + 0.14 * Math.cos(time * 0.31)
          : band
            ? 0.5 + 0.16 * Math.cos(time * 0.31)
            : 0.08 + 0.12 * Math.cos(time * 0.31));
      const violetX =
        width * (field ? 0.76 + 0.12 * Math.cos(time * 0.19) : 0.84 + 0.08 * Math.cos(time * 0.19));
      const violetY =
        height *
        (field
          ? 0.22 + 0.12 * Math.sin(time * 0.27)
          : band
            ? 0.5 + 0.12 * Math.sin(time * 0.27)
            : 0.04 + 0.1 * Math.sin(time * 0.27));
      for (let y = 0; y < rows; y++) {
        const py = y * CELL;
        const fade = field
          ? Math.min(1, Math.max(0, (1 - py / height) / 0.45)) ** 2
          : band
            ? Math.sin(Math.PI * Math.min(1, (py + CELL / 2) / height)) ** 1.5
            : Math.max(0, 1 - py / Math.min(height, FADE_PX)) ** 2;
        const row = y * columns;
        for (let x = 0; x < columns; x++) {
          const px = x * CELL;
          const wave = swell * Math.sin(px * 0.045 + py * 0.024 - time * 0.9);
          const orange =
            (Math.exp((-1.6 * ((px - orangeX) ** 2 + (py - orangeY) ** 2)) / reach) * 0.62 + wave) *
            fade;
          const violet =
            (Math.exp((-1.6 * ((px - violetX) ** 2 + (py - violetY) ** 2)) / reach) * 0.55 -
              wave * 0.5) *
            fade;
          const threshold = BAYER[(y & 3) * 4 + (x & 3)];
          pixels[row + x] =
            orange > threshold
              ? orange > threshold + 0.42
                ? palette.orangeBright
                : palette.orange
              : violet > BAYER[((y + 2) & 3) * 4 + ((x + 1) & 3)]
                ? palette.violet
                : 0;
        }
      }
      context.putImageData(image, 0, 0);
      canvas.dataset.ready = "";
    };

    const tick = () => {
      timer = 0;
      const now = performance.now();
      time += Math.min(now - last, 250) / 1000;
      last = now;
      render();
      if (hovering || now < until) timer = window.setTimeout(tick, 1000 / FPS);
    };

    const wake = (duration: number) => {
      if (motion.matches || document.visibilityState === "hidden") return;
      until = Math.max(until, performance.now() + duration);
      if (timer) return;
      last = performance.now();
      tick();
    };

    const sleep = () => {
      window.clearTimeout(timer);
      timer = 0;
    };

    const enter = () => {
      hovering = true;
      wake(0);
    };
    const leave = () => {
      hovering = false;
      wake(SETTLE_MS);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") sleep();
      else if (always) wake(Number.POSITIVE_INFINITY);
    };
    const preference = () => {
      sleep();
      render();
    };

    const resize = new ResizeObserver(() => {
      width = frame.clientWidth;
      height = frame.clientHeight;
      columns = Math.ceil(width / CELL);
      rows = Math.ceil(height / CELL);
      if (!columns || !rows) return;
      canvas.width = columns;
      canvas.height = rows;
      canvas.style.width = `${columns * CELL}px`;
      canvas.style.height = `${rows * CELL}px`;
      image = context.createImageData(columns, rows);
      pixels = new Uint32Array(image.data.buffer);
      render();
    });
    resize.observe(frame);
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", preference);
    wake(always ? Number.POSITIVE_INFINITY : ARRIVAL_MS);
    return () => {
      sleep();
      resize.disconnect();
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", preference);
    };
  }, [profile, drift]);
  return (
    <div className="dither-field" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
