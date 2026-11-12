// Persist logical display pixels, never physical pixels: works with Windows DPI.
export const sizes = { small: 220, medium: 280, large: 340 };
export function windowSize(size = 'medium') {
  const side = sizes[size] || sizes.medium;
  return { width: Math.max(300, side + 20), height: side + 130 };
}
export function clampBounds(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width), height = Math.min(bounds.height, workArea.height);
  return { width, height,
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))) };
}
export function initialBounds(settings, displays) {
  const area = displays.find(d => d.id === settings.displayId)?.workArea || displays[0].workArea;
  const dimensions = windowSize(settings.size);
  const x = Number.isFinite(settings.x) ? settings.x : area.x + area.width - dimensions.width - 28;
  const y = Number.isFinite(settings.y) ? settings.y : area.y + area.height - dimensions.height - 12;
  return clampBounds({ ...dimensions, x, y }, area);
}
export function cleanPreferences(value = {}) {
  return { size: Object.hasOwn(sizes, value.size) ? value.size : 'medium',
    alwaysOnTop: value.alwaysOnTop !== false, quiet: value.quiet === true,
    ...(Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : {}),
    ...(Number.isFinite(value.displayId) ? { displayId: value.displayId } : {}) };
}
