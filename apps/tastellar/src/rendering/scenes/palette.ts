export interface UniversePalette {
  dominant: string;
  vibrant: string;
  darkVibrant: string;
  lightVibrant: string;
  accent: string;
  extractionVersion: 1;
}

const cache = new Map<string, Promise<UniversePalette>>();
const MAX_CACHE = 96;

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededPalette(seed: string): UniversePalette {
  const hue = (hashSeed(seed || "tastellar") % 360 + 360) % 360;
  return {
    dominant: `hsl(${hue} 58% 48%)`,
    vibrant: `hsl(${hue} 76% 58%)`,
    darkVibrant: `hsl(${hue} 68% 30%)`,
    lightVibrant: `hsl(${hue} 72% 76%)`,
    accent: `hsl(${(hue + 24) % 360} 82% 66%)`,
    extractionVersion: 1,
  };
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

interface ColorBin {
  count: number;
  red: number;
  green: number;
  blue: number;
  saturation: number;
  luminance: number;
}

function extractPixels(pixels: Uint8ClampedArray, seed: string): UniversePalette {
  const bins = new Map<number, ColorBin>();
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha < 0.32) continue;
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0, saturation: 0, luminance: 0 };
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    bin.count += alpha;
    bin.red += red * alpha;
    bin.green += green * alpha;
    bin.blue += blue * alpha;
    bin.saturation += max === 0 ? 0 : (max - min) / max * alpha;
    bin.luminance += (0.2126 * red + 0.7152 * green + 0.0722 * blue) * alpha;
    bins.set(key, bin);
  }

  const values = [...bins.values()].filter((bin) => bin.count > 0);
  if (values.length === 0) return seededPalette(seed);
  const color = (bin: ColorBin) => ({
    red: bin.red / bin.count,
    green: bin.green / bin.count,
    blue: bin.blue / bin.count,
    saturation: bin.saturation / bin.count,
    luminance: bin.luminance / bin.count,
  });
  const dominantBin = values.reduce((best, next) => next.count > best.count ? next : best);
  const vividness = (bin: ColorBin) => {
    const measured = color(bin);
    return bin.count * (0.15 + measured.saturation) * (0.45 + Math.min(measured.luminance, 245 - measured.luminance) / 180);
  };
  const vibrantBin = values.reduce((best, next) => vividness(next) > vividness(best) ? next : best);
  const darkBin = values.filter((bin) => color(bin).luminance < 120).sort((a, b) => vividness(b) - vividness(a))[0] ?? vibrantBin;
  const lightBin = values.filter((bin) => color(bin).luminance > 150).sort((a, b) => vividness(b) - vividness(a))[0] ?? vibrantBin;
  const hex = (bin: ColorBin) => {
    const value = color(bin);
    return rgbHex(value.red, value.green, value.blue);
  };
  const vibrancy = color(vibrantBin);
  if (vibrancy.saturation < 0.16) {
    const fallback = seededPalette(seed);
    return {
      dominant: hex(dominantBin),
      vibrant: fallback.vibrant,
      darkVibrant: fallback.darkVibrant,
      lightVibrant: fallback.lightVibrant,
      accent: fallback.accent,
      extractionVersion: 1,
    };
  }
  const accent = rgbHex(vibrancy.red * 0.84 + 255 * 0.16, vibrancy.green * 0.84 + 255 * 0.16, vibrancy.blue * 0.84 + 255 * 0.16);
  return {
    dominant: hex(dominantBin),
    vibrant: hex(vibrantBin),
    darkVibrant: hex(darkBin),
    lightVibrant: hex(lightBin),
    accent,
    extractionVersion: 1,
  };
}

function sourceKey(source: string): string {
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 2246822519);
  }
  return `${source.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

/** Extract a small cached palette when a cover asset is loaded, never from a render frame. */
export function extractCoverPalette(source: string, stableSeed = source, cacheKey?: string): Promise<UniversePalette> {
  const key = cacheKey ?? sourceKey(source);
  const cached = cache.get(key);
  if (cached) return cached;
  const result = new Promise<UniversePalette>((resolve) => {
    if (typeof document === "undefined" || typeof Image === "undefined") {
      resolve(seededPalette(stableSeed));
      return;
    }
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          resolve(seededPalette(stableSeed));
          return;
        }
        context.drawImage(image, 0, 0, 32, 32);
        resolve(extractPixels(context.getImageData(0, 0, 32, 32).data, stableSeed));
      } catch {
        resolve(seededPalette(stableSeed));
      }
    };
    image.onerror = () => resolve(seededPalette(stableSeed));
    image.src = source;
  });
  cache.set(key, result);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return result;
}

export function paletteFromSeed(seed: string): UniversePalette {
  return seededPalette(seed);
}
