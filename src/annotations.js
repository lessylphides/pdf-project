// Annotation model helpers. All coordinates are PDF points in the page's
// unrotated space, measured from the top-left corner of the visible page box
// (x to the right, y downward).
import { measureText } from './text.js';

let counter = 0;
export const newId = () => `a${Date.now().toString(36)}${(counter++).toString(36)}`;

export function bbox(ann) {
  switch (ann.type) {
    case 'text': {
      const { w, h } = measureText(ann);
      return { x: ann.x, y: ann.y, w: Math.max(w, 4), h };
    }
    case 'line':
      return {
        x: Math.min(ann.x1, ann.x2),
        y: Math.min(ann.y1, ann.y2),
        w: Math.abs(ann.x2 - ann.x1),
        h: Math.abs(ann.y2 - ann.y1),
      };
    case 'ink': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of ann.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'markup':
      return unionRects(ann.quads);
    default:
      return { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
  }
}

export function unionRects(rects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return rects.length ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Notes keep a fixed icon size and markups follow the text they mark. */
export const canResize = (ann) => ann.type !== 'note' && ann.type !== 'markup';

export function translate(ann, dx, dy) {
  switch (ann.type) {
    case 'line':
      ann.x1 += dx; ann.x2 += dx; ann.y1 += dy; ann.y2 += dy;
      break;
    case 'ink':
      ann.points = ann.points.map(([x, y]) => [x + dx, y + dy]);
      break;
    case 'markup':
      ann.quads = ann.quads.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy }));
      break;
    default:
      ann.x += dx; ann.y += dy;
  }
}

/**
 * Resize `ann` (whose state is `orig`, a snapshot taken when the drag began)
 * so its bounding box's bottom-right corner lands at (px, py).
 */
export function resizeTo(ann, orig, px, py, keepRatio) {
  if (!canResize(ann)) return;
  const b = bbox(orig);
  let w = Math.max(px - b.x, 2);
  let h = Math.max(py - b.y, 2);
  if (keepRatio && b.w > 0 && b.h > 0) {
    const s = Math.max(w / b.w, h / b.h);
    w = b.w * s;
    h = b.h * s;
  }
  switch (ann.type) {
    case 'text': {
      const s = Math.max(h / Math.max(b.h, 1), 0.05);
      ann.size = Math.max(4, Math.round(orig.size * s * 10) / 10);
      break;
    }
    case 'line': {
      const sx = b.w ? w / b.w : 1;
      const sy = b.h ? h / b.h : 1;
      ann.x1 = b.x + (orig.x1 - b.x) * sx;
      ann.x2 = b.x + (orig.x2 - b.x) * sx;
      ann.y1 = b.y + (orig.y1 - b.y) * sy;
      ann.y2 = b.y + (orig.y2 - b.y) * sy;
      break;
    }
    case 'ink': {
      const sx = b.w ? w / b.w : 1;
      const sy = b.h ? h / b.h : 1;
      ann.points = orig.points.map(([x, y]) => [b.x + (x - b.x) * sx, b.y + (y - b.y) * sy]);
      break;
    }
    default:
      ann.w = w;
      ann.h = h;
  }
}

export function inkPath(points) {
  if (!points.length) return '';
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${x} ${y} L${x + 0.01} ${y}`;
  }
  // Smooth with quadratic curves through midpoints.
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = points[points.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return d;
}

/** Drop points that are closer than `tol` to the previous kept point. */
export function simplify(points, tol) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1];
    const [x, y] = points[i];
    if (Math.hypot(x - px, y - py) >= tol) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}
