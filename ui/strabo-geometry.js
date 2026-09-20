/**
 * Chart geometry for the Architecture Health radar and the Dependency constellation.
 * Positions are deterministic so the diagrams are stable across renders.
 *
 * Pure functions only: no DOM, no fetch.
 */

import { hash } from './strabo-graph.js';

/**
 * Points for the Architecture Health radar, one per axis.
 *
 * A null axis (unavailable) collapses to the centre so the gap in evidence is visible
 * instead of being drawn as a zero score.
 */
export function radarPoints(axes, { radius = 54, center = 72 } = {}) {
  const count = Math.max(1, axes.length);
  return axes.map((axis, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    const ratio = axis.value === null ? 0 : Math.max(0, Math.min(100, axis.value)) / 100;
    return {
      label: axis.label,
      value: axis.value,
      x: center + Math.cos(angle) * radius * ratio,
      y: center + Math.sin(angle) * radius * ratio,
    };
  });
}

/** The outline of the radar frame, at full radius, for the grid rings. */
export function radarFrame(axes, { radius = 54, center = 72 } = {}) {
  return radarPoints(
    axes.map(() => ({ value: 100, label: '' })),
    { radius, center },
  );
}

export function polygonPoints(points) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/**
 * Points for the Dependency constellation: fields, methods, and repository consumers.
 * Positions are seeded from the member key so the layout is stable across renders.
 */
export function constellationLayout(points, { width = 280, height = 180 } = {}) {
  return points.map((point) => {
    const seed = hash(point.key);
    const angle = (seed % 360) * (Math.PI / 180);
    const ring =
      point.kind === 'consumer' ? 0.42 : 0.3 + (((seed >> 3) % 40) / 100) * 0.7;
    const radius = Math.min(width, height) / 2;
    return {
      ...point,
      x: width / 2 + Math.cos(angle) * radius * ring,
      y: height / 2 + Math.sin(angle) * radius * ring,
    };
  });
}

export function constellationPoints(memberMap, consumers) {
  const points = [];
  for (const type of memberMap?.types ?? []) {
    for (const field of type.fields) {
      points.push({ key: `field:${type.name}.${field.name}`, kind: 'field', label: field.name });
    }
    for (const method of type.methods) {
      points.push({ key: `method:${type.name}.${method.name}`, kind: 'method', label: method.name });
    }
  }
  const count = Math.max(0, consumers ?? 0);
  for (let index = 0; index < count; index += 1) {
    points.push({ key: `consumer:${index}`, kind: 'consumer', label: '' });
  }
  return points;
}
