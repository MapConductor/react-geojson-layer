export function colorArgb(a: number, r: number, g: number, b: number): number {
    return ((a << 24) | (r << 16) | (g << 8) | b) | 0;
}

export function colorRgb(r: number, g: number, b: number): number {
    return (0xff000000 | (r << 16) | (g << 8) | b) | 0;
}

export function colorAlpha(c: number): number { return (c >>> 24) & 0xff; }
export function colorRed(c: number): number { return (c >>> 16) & 0xff; }
export function colorGreen(c: number): number { return (c >>> 8) & 0xff; }
export function colorBlue(c: number): number { return c & 0xff; }

export function argbToCss(argb: number): string {
    const u = argb >>> 0;
    const a = ((u >>> 24) & 0xff) / 255;
    const r = (u >>> 16) & 0xff;
    const g = (u >>> 8) & 0xff;
    const b = u & 0xff;
    return `rgba(${r},${g},${b},${a.toFixed(4)})`;
}

export const GeoJSONDefaults = {
    DEFAULT_OPACITY: 1.0,
    DEFAULT_STROKE_COLOR: colorArgb(255, 30, 136, 229),
    DEFAULT_FILL_COLOR: colorArgb(128, 30, 136, 229),
    DEFAULT_STROKE_WIDTH: 2,
    DEFAULT_POINT_RADIUS: 8,
    DEFAULT_TILE_SIZE: 512,
    DEFAULT_MAX_ZOOM: 22,
} as const;
