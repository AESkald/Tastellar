import {
  buildSceneLayout,
  stableHash,
  type LayoutObject,
  type SceneLayout,
  type SpriteKind,
  type UniverseProjection,
  type UniverseQuality,
  type UniverseRendererOptions,
  type UniverseScreenObject,
  type UniverseTheme,
  type UniverseViewState,
  type UniverseWork,
} from "./sceneLayout";
import { paletteFromSeed } from "./palette";
import { createScaleTransition, sampleScaleTransition, type ScaleTransition } from "./scaleTransition";

export type {
  UniverseGroup,
  UniverseProjection,
  UniverseQuality,
  UniverseRendererOptions,
  UniverseRendererStatus,
  UniverseScreenObject,
  UniverseTheme,
  UniverseViewState,
  UniverseWork,
} from "./sceneLayout";
export type { UniversePalette } from "./palette";
export { extractCoverPalette, paletteFromSeed } from "./palette";
export { buildSceneLayout, isScaleTransition, selectLabelWorkIds } from "./sceneLayout";

const BILLBOARD_VERTEX = `
attribute vec3 aPosition;
attribute vec4 aColor;
attribute float aSize;
attribute float aKind;
attribute float aSeed;
attribute vec2 aCorner;
uniform mat4 uViewProjection;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uCameraFacing;
uniform vec3 uSunPosition;
varying vec4 vColor;
varying float vKind;
varying float vSeed;
varying vec2 vPoint;
varying vec3 vLightDirection;
void main() {
  vec3 billboardRight = uCameraRight;
  vec3 billboardUp = uCameraUp;
  if (aKind > 7.5 && aKind < 8.5) {
    // Background galaxies occupy fixed tilted planes on the world sky shell.
    // Only their constituent glow quad faces the camera; the galaxy itself
    // rotates with the scene like every other celestial object.
    vec3 radial = normalize(aPosition);
    vec3 reference = abs(radial.y) < 0.86 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent = normalize(cross(reference, radial));
    float inclination = 0.18 + fract(aSeed * 17.7) * 0.82;
    vec3 normal = normalize(radial * cos(inclination) + tangent * sin(inclination));
    vec3 axisU = normalize(cross(reference, normal));
    vec3 axisV = normalize(cross(normal, axisU));
    float spin = fract(aSeed * 53.2) * 6.2831853;
    billboardRight = axisU * cos(spin) + axisV * sin(spin);
    billboardUp = normalize(cross(normal, billboardRight));
  }
  vec3 position = aPosition + (billboardRight * aCorner.x + billboardUp * aCorner.y) * aSize;
  gl_Position = uViewProjection * vec4(position, 1.0);
  vColor = aColor;
  vKind = aKind;
  vSeed = aSeed;
  vPoint = aCorner;
  vec3 toSun = uSunPosition - aPosition;
  vLightDirection = normalize(vec3(dot(toSun, uCameraRight), dot(toSun, uCameraUp), dot(toSun, uCameraFacing)));
}`;

const BILLBOARD_FRAGMENT = `
precision mediump float;
uniform float uRenderPass;
uniform float uLightMode;
uniform vec3 uHorizonColor;
varying vec4 vColor;
varying float vKind;
varying float vSeed;
varying vec2 vPoint;
varying vec3 vLightDirection;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed * 19.17) * 43758.5453123);
}
void main() {
  vec2 p = vPoint;
  float r = length(p);
  float angle = atan(p.y, p.x);
  float alpha = 0.0;
  vec3 tint = vColor.rgb;
  if (uRenderPass < 0.5) {
    if (vKind > 9.5) {
      float core = 1.0 - smoothstep(0.26, 0.58, r);
      float halo = exp(-r * r * 5.2) * mix(0.34, 0.22, uLightMode);
      alpha = max(core * mix(0.48, 0.32, uLightMode), halo) * vColor.a;
      tint *= 1.12;
    } else if (vKind < 0.5) {
      float halo = exp(-r * r * 8.0) * mix(0.28, 0.11, uLightMode);
      float core = 1.0 - smoothstep(0.16, 0.56, r);
      alpha = max(halo, core * mix(0.28, 0.13, uLightMode)) * vColor.a;
    } else if (vKind < 1.5) {
      alpha = exp(-r * r * 3.5) * mix(0.42, 0.12, uLightMode) * vColor.a;
    } else if (vKind < 2.5) {
      float diskR = length(vec2(p.x * 1.14, p.y * 1.62));
      float glow = exp(-diskR * 2.9) * (1.0 - smoothstep(0.64, 1.28, diskR));
      alpha = glow * mix(0.24, 0.095, uLightMode) * vColor.a;
    } else if (vKind < 4.5) {
      if (vKind > 3.5) {
        float archY = 0.24 - p.x * p.x * 0.17;
        float wingFade = 1.0 - smoothstep(0.64, 0.96, abs(p.x));
        float upperArch = exp(-pow((p.y - archY) / 0.036, 2.0)) * wingFade;
        float lowerArch = exp(-pow((p.y + archY * 0.78) / 0.040, 2.0)) * wingFade;
        float foregroundDisk = exp(-pow((p.y + 0.105) / 0.030, 2.0)) * (1.0 - smoothstep(0.66, 0.96, abs(p.x)));
        float horizonGlow = exp(-pow((r - 0.39) * 9.0, 2.0)) * 0.10;
        float lensingBand = max(max(upperArch, lowerArch * 0.76), foregroundDisk * 0.96);
        alpha = max(horizonGlow, lensingBand * mix(0.94, 0.60, uLightMode)) * vColor.a;
        tint = mix(tint, mix(vec3(1.0, 0.49, 0.24), vec3(0.32, 0.17, 0.07), uLightMode), 0.68);
      } else discard;
    } else if (vKind < 6.5) {
      float corona = exp(-r * 2.5) * (1.0 - smoothstep(0.91, 1.0, r));
      alpha = corona * mix(0.58, 0.32, uLightMode) * vColor.a;
      tint = mix(tint, mix(vec3(1.0, 0.56, 0.22), vec3(0.25, 0.12, 0.06), uLightMode), 0.45);
    } else {
      float armVolume = exp(-dot(p, p) * 3.6);
      alpha = armVolume * mix(0.25, 0.13, uLightMode) * vColor.a;
      tint = mix(tint, vec3(1.0), uLightMode * 0.24);
    }
    if (alpha < 0.0004) discard;
    gl_FragColor = vec4(tint, clamp(alpha, 0.0, 1.0));
    return;
  }

  if (uRenderPass < 1.5) {
    if (vKind > 9.5) {
      if (r > 0.50) discard;
      alpha = vColor.a * (1.0 - smoothstep(0.39, 0.50, r));
      tint *= mix(1.22, 1.30, uLightMode);
    } else if (vKind > 8.5) {
      // Environment stars keep a solid pixel core so they remain visible on
      // pale surfaces without relying on a subpixel glow or a depth-writing quad.
      if (r > 0.50) discard;
      alpha = vColor.a;
    } else if (vKind < 0.5) {
      alpha = vColor.a * (1.0 - smoothstep(0.34, 0.50, r));
      tint *= 1.05 + (1.0 - smoothstep(0.0, 0.48, r)) * 0.16;
    } else if (vKind < 1.5) {
      if (r > 0.52) discard;
      vec2 sphereXY = p * 2.0;
      vec3 normal = normalize(vec3(sphereXY, sqrt(max(0.0, 1.0 - dot(sphereXY, sphereXY)))));
      vec3 lightDirection = normalize(vLightDirection);
      float diffuse = max(0.0, dot(normal, lightDirection));
      float nightFill = 0.012;
      float dayLight = mix(1.42, 0.90, uLightMode);
      vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
      float specular = pow(max(0.0, dot(normal, halfVector)), 20.0) * 0.82 * smoothstep(0.0, 0.12, diffuse);
      float lighting = nightFill + dayLight * diffuse + specular;
      alpha = vColor.a * (1.0 - smoothstep(0.42, 0.51, r));
      tint *= lighting;
    } else if (vKind < 2.5) {
      float orient = vSeed * 6.2831853;
      vec2 q = vec2(cos(orient) * p.x - sin(orient) * p.y, sin(orient) * p.x + cos(orient) * p.y);
      q *= vec2(1.02 + fract(vSeed * 11.7) * 0.24, 0.72 + fract(vSeed * 7.3) * 0.18);
      float galaxyR = length(q);
      float galaxyAngle = atan(q.y, q.x);
      float armCount = 2.0 + floor(fract(vSeed * 19.1) * 3.0);
      float armWave = cos(galaxyAngle * armCount - galaxyR * (6.0 + armCount * 0.9) + vSeed * 37.0);
      float arm = pow(max(0.0, 0.5 + 0.5 * armWave), 4.0);
      float envelope = exp(-galaxyR * 2.45) * (1.0 - smoothstep(0.58, 1.28, galaxyR));
      vec2 cell = floor((q + 1.3) * 34.0);
      vec2 local = fract((q + 1.3) * 34.0) - 0.5;
      float randomValue = hash(cell);
      vec2 jitter = vec2(hash(cell + 3.7), hash(cell + 8.2)) * 0.26 - 0.13;
      float speck = 1.0 - smoothstep(0.025, 0.16, length(local + jitter));
      float grain = step(0.67 - arm * 0.26, randomValue) * speck;
      float core = exp(-galaxyR * 7.2);
      alpha = clamp((grain * (0.22 + arm * 0.84) + core * 0.50) * envelope, 0.0, 1.0) * vColor.a;
      tint *= 0.72 + envelope * (0.42 + arm * 0.54) + core * 0.42;
      if (alpha < 0.006) discard;
    } else if (vKind > 7.5) {
      float orient = vSeed * 6.2831853;
      vec2 q = vec2(cos(orient) * p.x - sin(orient) * p.y, sin(orient) * p.x + cos(orient) * p.y);
      q *= vec2(1.05, 0.78);
      float galaxyR = length(q);
      float galaxyAngle = atan(q.y, q.x);
      float armCount = 2.0 + floor(fract(vSeed * 19.1) * 2.0);
      float armWave = cos(galaxyAngle * armCount - galaxyR * (7.0 + armCount * 0.72) + vSeed * 37.0);
      float armFactor = smoothstep(0.42, 0.94, armWave);
      vec2 cell = floor((q + 1.2) * 30.0);
      vec2 local = fract((q + 1.2) * 30.0) - 0.5;
      vec2 jitter = vec2(hash(cell + 2.3), hash(cell + 6.1)) * 0.56 - 0.28;
      float particleShape = 1.0 - smoothstep(0.10, 0.27, length(local + jitter));
      float particle = step(hash(cell), mix(0.035, 0.72, armFactor)) * particleShape;
      float edge = 1.0 - smoothstep(0.76, 1.02, galaxyR);
      float galaxyCore = exp(-galaxyR * galaxyR * 56.0);
      float bulge = exp(-galaxyR * galaxyR * 8.0);
      float softLight = exp(-galaxyR * 2.7) * (0.08 + armFactor * 0.09);
      alpha = (particle * 0.78 + galaxyCore * 0.82 + bulge * 0.06 + softLight) * edge * vColor.a * mix(1.30, 0.88, uLightMode);
      tint *= 0.58 + armFactor * 0.24 + particle * 0.88 + galaxyCore * 0.70;
      tint = mix(tint, vec3(1.0), galaxyCore * 0.38);
      if (alpha < 0.006) discard;
    } else if (vKind < 3.5) {
      float facetIndex = floor((angle + 3.14159) * 9.0);
      float edgeNoise = hash(vec2(facetIndex, floor(vSeed * 23.0)));
      float uneven = 0.72 + edgeNoise * 0.20 + 0.055 * sin(angle * 3.0 + vSeed * 8.0) + 0.025 * cos(angle * 7.0 + vSeed * 17.0);
      if (r > uneven) discard;
      float facets = floor((angle + 3.14159) * 9.0);
      float shade = 0.48 + hash(vec2(facets + 3.0, floor(vSeed * 7.0))) * 0.34 + 0.08 * p.y;
      float crater = (1.0 - smoothstep(0.02, 0.12, length(p - vec2(0.24 * sin(vSeed * 8.0), 0.18 * cos(vSeed * 6.0))))) * 0.10;
      tint *= shade - crater;
      alpha = vColor.a;
    } else if (vKind < 4.5) {
      discard;
    } else if (vKind < 5.5 || vKind > 6.5) {
      discard;
    } else {
      alpha = 1.0 - smoothstep(0.40, 0.50, r);
      vec3 sunCenter = mix(vec3(1.0, 0.94, 0.72), vec3(0.48, 0.32, 0.10), uLightMode);
      tint = mix(sunCenter, tint, smoothstep(0.05, 0.49, r) * 0.48);
    }
  } else {
    // This pass is also used as an early opaque-horizon prepass for the black hole.
    if (vColor.a < 0.98) discard;
    if (vKind < 0.5) {
      if (r > 0.50) discard;
    } else if (vKind < 1.5) {
      // Planet illumination was composited in the surface pass. Repainting an
      // unlit opaque core here would erase its world-lit day/night terminator.
      discard;
    } else if (vKind < 2.5) {
      discard;
    } else if (vKind < 3.5) {
      float facetIndex = floor((angle + 3.14159) * 9.0);
      float edgeNoise = hash(vec2(facetIndex, floor(vSeed * 23.0)));
      float uneven = 0.72 + edgeNoise * 0.20 + 0.055 * sin(angle * 3.0 + vSeed * 8.0) + 0.025 * cos(angle * 7.0 + vSeed * 17.0);
      if (r > uneven) discard;
      float facets = floor((angle + 3.14159) * 9.0);
      tint *= 0.48 + hash(vec2(facets + 3.0, floor(vSeed * 7.0))) * 0.34 + 0.08 * p.y;
    } else if (vKind < 4.5) {
      if (r > 0.36) discard;
      tint = uHorizonColor;
    } else if (vKind < 5.5 || vKind > 6.5) {
      discard;
    } else {
      if (r > 0.50) discard;
      tint = mix(vColor.rgb, mix(vec3(1.0, 0.91, 0.68), vec3(0.48, 0.32, 0.10), uLightMode), 0.78);
    }
    alpha = 1.0;
  }
  if (alpha < 0.0004) discard;
  gl_FragColor = vec4(tint, clamp(alpha, 0.0, 1.0));
}`;

const LINE_VERTEX = `
attribute vec3 aPosition;
attribute vec4 aColor;
uniform mat4 uViewProjection;
varying vec4 vColor;
void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
  vColor = aColor;
}`;
const LINE_FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() { gl_FragColor = vColor; }
`;

type Matrix = Float32Array;
interface GLProgramInfo {
  program: WebGLProgram;
  position: number;
  color: number;
  size?: number;
  kind?: number;
  seed?: number;
  corner?: number;
  viewProjection: WebGLUniformLocation | null;
  cameraRight?: WebGLUniformLocation | null;
  cameraUp?: WebGLUniformLocation | null;
  cameraFacing?: WebGLUniformLocation | null;
  sunPosition?: WebGLUniformLocation | null;
  lightMode?: WebGLUniformLocation | null;
  horizonColor?: WebGLUniformLocation | null;
  renderPass?: WebGLUniformLocation | null;
}
interface GLResources {
  gl: WebGLRenderingContext;
  billboard: GLProgramInfo;
  line: GLProgramInfo;
  billboardBuffer: WebGLBuffer;
  lineBuffer: WebGLBuffer;
}
interface MutableNode extends LayoutObject {
  key: string;
  currentX: number;
  currentY: number;
  currentZ: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  startTime: number;
  transitionDuration: number;
  opacity: number;
  targetAlpha: number;
  fadingOut: boolean;
}
interface CameraState {
  yaw: number;
  pitch: number;
  yawFrom: number;
  yawTarget: number;
  pitchFrom: number;
  pitchTarget: number;
  orientationStarted: number;
  orientationDuration: number;
  distance: number;
  targetDistance: number;
  distanceFrom: number;
  distanceStarted: number;
  distanceDuration: number;
}
interface ScaleTransitionState {
  plan: ScaleTransition;
  startedAt: number;
  sourceNodes: Map<string, MutableNode>;
  incomingNodes: Map<string, MutableNode>;
  incomingLayout: SceneLayout;
  incomingProjection: UniverseProjection;
  sourceBridge: [number, number, number];
  targetBridge: [number, number, number];
  sourceYaw: number;
  targetYaw: number;
  sourcePitch: number;
  targetPitch: number;
  settledTargetFit: number;
  sourcePan: [number, number];
  targetPan: [number, number];
  wideFov: boolean;
  switched: boolean;
}
interface SkySprite {
  kind: SpriteKind;
  x: number;
  y: number;
  z: number;
  size: number;
  color: string;
  seed: number;
  alpha: number;
  planeU?: [number, number, number];
  planeV?: [number, number, number];
}

const KIND_CODE: Record<SpriteKind, number> = { star: 0, planet: 1, galaxy: 2, asteroid: 3, blackHole: 4, nebula: 5, sun: 6, armGlow: 7 };
const TRANSITION_FOV = Math.PI / 2;
const TRANSITION_FIT_RATIO = Math.tan(Math.PI / 6) / Math.tan(TRANSITION_FOV / 2);
const TRANSITION_HANDOFF = 0.48;
const SKY_STAR_KIND_CODE = 9;
const SKY_GALAXY_KIND_CODE = 8;
const CONSTELLATION_STAR_KIND_CODE = 10;
function identity(): Matrix {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}
function perspective(fovy: number, aspect: number, near: number, far: number): Matrix {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}
function orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Matrix {
  const out = identity();
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -2 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  return out;
}
function translation(x: number, y: number, z: number): Matrix {
  const out = identity();
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}
function rotationX(angle: number): Matrix {
  const out = identity();
  const c = Math.cos(angle), s = Math.sin(angle);
  out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
  return out;
}
function rotationY(angle: number): Matrix {
  const out = identity();
  const c = Math.cos(angle), s = Math.sin(angle);
  out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
  return out;
}
function transform(matrix: Matrix, x: number, y: number, z: number): [number, number, number, number] {
  return [matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13], matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14], matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]];
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function mix(a: number, b: number, amount: number): number { return a + (b - a) * amount; }
function smooth(amount: number): number { return amount * amount * (3 - 2 * amount); }
function layoutPitch(scene: SceneLayout): number {
  const declared = (scene as SceneLayout & { defaultPitch?: number }).defaultPitch;
  if (Number.isFinite(declared)) return clamp(declared!, -1.3, 1.3);
  return scene.group === "10" || scene.group === "dropped" ? 0.95 : 0.08;
}
function layoutYaw(scene: SceneLayout): number {
  const declared = (scene as SceneLayout & { defaultYaw?: number }).defaultYaw;
  return Number.isFinite(declared) ? declared! : 0;
}
function unit(seed: number, offset = 0): number {
  let value = (seed + Math.imul(offset + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function skyGalaxyPlane(position: [number, number, number], seedValue: number): { planeU: [number, number, number]; planeV: [number, number, number] } {
  const length = Math.max(0.0001, Math.hypot(position[0], position[1], position[2]));
  const radial: [number, number, number] = [position[0] / length, position[1] / length, position[2] / length];
  const reference: [number, number, number] = Math.abs(radial[1]) < 0.86 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = (value: [number, number, number]): [number, number, number] => {
    const size = Math.max(0.0001, Math.hypot(value[0], value[1], value[2]));
    return [value[0] / size, value[1] / size, value[2] / size];
  };
  const tangent = normalize(cross(reference, radial));
  const inclination = 0.18 + ((seedValue * 17.7) % 1) * 0.82;
  const normal = normalize([
    radial[0] * Math.cos(inclination) + tangent[0] * Math.sin(inclination),
    radial[1] * Math.cos(inclination) + tangent[1] * Math.sin(inclination),
    radial[2] * Math.cos(inclination) + tangent[2] * Math.sin(inclination),
  ]);
  const axisU = normalize(cross(reference, normal));
  const axisV = normalize(cross(normal, axisU));
  const spin = ((seedValue * 53.2) % 1) * Math.PI * 2;
  const planeU: [number, number, number] = [
    axisU[0] * Math.cos(spin) + axisV[0] * Math.sin(spin),
    axisU[1] * Math.cos(spin) + axisV[1] * Math.sin(spin),
    axisU[2] * Math.cos(spin) + axisV[2] * Math.sin(spin),
  ];
  return { planeU, planeV: normalize(cross(normal, planeU)) };
}

function buildSkySprites(): { stars: SkySprite[]; galaxies: SkySprite[] } {
  const stars: SkySprite[] = [];
  for (let index = 0; index < 1440; index += 1) {
    const seed = stableHash(`tastellar-sky-star-${index}`);
    const longitude = unit(seed, 0) * Math.PI * 2;
    const latitude = Math.asin(unit(seed, 1) * 2 - 1);
    const radius = 690;
    const spread = Math.cos(latitude) * radius;
    stars.push({
      kind: "star",
      x: Math.cos(longitude) * spread,
      y: Math.sin(latitude) * radius,
      z: Math.sin(longitude) * spread,
      size: 0.55 + unit(seed, 2) * 0.38,
      color: "#020204",
      seed,
      alpha: 1,
    });
  }
  const galaxies: SkySprite[] = [];
  const galaxyCount = 32;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < galaxyCount; index += 1) {
    const seed = stableHash(`tastellar-sky-galaxy-${index}`);
    const y = 1 - 2 * (index + 0.5) / galaxyCount;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const longitude = index * goldenAngle;
    const direction: [number, number, number] = [Math.cos(longitude) * ring, y, Math.sin(longitude) * ring];
    const shellRadius = 650;
    const center: [number, number, number] = [direction[0] * shellRadius, direction[1] * shellRadius, direction[2] * shellRadius];
    const color = index % 3 === 0 ? "#d4a8de" : index % 2 ? "#8daee5" : "#f0c59a";
    const { planeU, planeV } = skyGalaxyPlane(center, (seed % 1000) / 1000);
    galaxies.push({
      kind: "galaxy",
      x: center[0], y: center[1], z: center[2],
      size: 78 + unit(seed, 3) * 38,
      color,
      seed,
      alpha: 0.18 + unit(seed, 4) * 0.09,
      planeU,
      planeV,
    });
  }
  return { stars, galaxies };
}

function parseColorFactory(documentRef: Document): (color: string, alpha?: number) => [number, number, number, number] {
  const canvas = documentRef.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map<string, [number, number, number]>();
  return (color, alpha = 1) => {
    const cached = color.includes("var(") ? undefined : cache.get(color);
    if (cached) return [cached[0], cached[1], cached[2], alpha];
    let resolved = color;
    if (color.includes("var(")) {
      const probe = documentRef.createElement("span");
      probe.style.color = color;
      documentRef.body.appendChild(probe);
      resolved = getComputedStyle(probe).color || "#ffffff";
      probe.remove();
    }
    if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#fff";
      context.fillStyle = resolved;
      context.fillRect(0, 0, 1, 1);
      try {
        const sample = context.getImageData(0, 0, 1, 1).data;
        const value: [number, number, number] = [sample[0] / 255, sample[1] / 255, sample[2] / 255];
        if (!color.includes("var(")) cache.set(color, value);
        return [...value, alpha];
      } catch { /* Keep CSS parser's default below. */ }
    }
    const hex = /^#([\da-f]{3,8})$/i.exec(resolved);
    if (hex) {
      let digits = hex[1];
      if (digits.length === 3) digits = digits.split("").map((digit) => digit + digit).join("");
      const value: [number, number, number] = [parseInt(digits.slice(0, 2), 16) / 255, parseInt(digits.slice(2, 4), 16) / 255, parseInt(digits.slice(4, 6), 16) / 255];
      if (!color.includes("var(")) cache.set(color, value);
      return [...value, alpha];
    }
    return [1, 1, 1, alpha];
  };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}
function linkProgram(gl: WebGLRenderingContext, vertex: string, fragment: string, billboard: boolean): GLProgramInfo {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate program");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "program linking failed";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return {
    program,
    position: gl.getAttribLocation(program, "aPosition"),
    color: gl.getAttribLocation(program, "aColor"),
    size: billboard ? gl.getAttribLocation(program, "aSize") : undefined,
    kind: billboard ? gl.getAttribLocation(program, "aKind") : undefined,
    seed: billboard ? gl.getAttribLocation(program, "aSeed") : undefined,
    corner: billboard ? gl.getAttribLocation(program, "aCorner") : undefined,
    viewProjection: gl.getUniformLocation(program, "uViewProjection"),
    cameraRight: billboard ? gl.getUniformLocation(program, "uCameraRight") : undefined,
    cameraUp: billboard ? gl.getUniformLocation(program, "uCameraUp") : undefined,
    cameraFacing: billboard ? gl.getUniformLocation(program, "uCameraFacing") : undefined,
    sunPosition: billboard ? gl.getUniformLocation(program, "uSunPosition") : undefined,
    lightMode: billboard ? gl.getUniformLocation(program, "uLightMode") : undefined,
    horizonColor: billboard ? gl.getUniformLocation(program, "uHorizonColor") : undefined,
    renderPass: billboard ? gl.getUniformLocation(program, "uRenderPass") : undefined,
  };
}
function makeGLResources(gl: WebGLRenderingContext): GLResources {
  const billboard = linkProgram(gl, BILLBOARD_VERTEX, BILLBOARD_FRAGMENT, true);
  const line = linkProgram(gl, LINE_VERTEX, LINE_FRAGMENT, false);
  const billboardBuffer = gl.createBuffer();
  const lineBuffer = gl.createBuffer();
  if (!billboardBuffer || !lineBuffer) throw new Error("Unable to allocate scene buffers");
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  return { gl, billboard, line, billboardBuffer, lineBuffer };
}

function spriteKindCode(kind: SpriteKind): number { return KIND_CODE[kind]; }

function shiftedPosition(node: MutableNode, time: number, asteroidHalfSpan = 13): [number, number, number] {
  if (node.orbitRadius !== undefined && node.orbitSpeed !== undefined && node.orbitPhase !== undefined) {
    const angle = node.orbitPhase + time * node.orbitSpeed;
    const phase = node.orbitPhase;
    const radius = node.orbitRadius;
    const baseX = Math.cos(phase) * radius;
    const yScale = node.orbitYScale ?? 0;
    const baseY = Math.sin(phase) * radius * yScale;
    const baseZ = Math.sin(phase) * radius;
    return [node.currentX + Math.cos(angle) * radius - baseX, node.currentY + Math.sin(angle) * radius * yScale - baseY, node.currentZ + Math.sin(angle) * radius - baseZ];
  }
  if (node.kind === "asteroid" && (node.driftX || node.driftY)) {
    const halfSpan = asteroidHalfSpan;
    const span = halfSpan * 2;
    const speed = Math.max(0.018, Math.abs(node.driftX ?? 0.12));
    const x = ((node.currentX + time * speed + halfSpan) % span + span) % span - halfSpan;
    return [x, node.currentY, node.currentZ];
  }
  return [node.currentX, node.currentY, node.currentZ];
}

export interface UniverseRenderer {
  updateProjection(projection: UniverseProjection): void;
  updateTheme(theme: UniverseTheme): void;
  updateSelection(id: string | null): void;
  updateQuality(quality: UniverseQuality): void;
  updateMotion(enabled: boolean): void;
  setActive(active: boolean): void;
  getViewState(): UniverseViewState;
  restoreViewState(state: UniverseViewState): void;
  /** Rotate the view in response to keyboard controls. Inputs use CSS-pixel-like deltas. */
  rotateBy(deltaX: number, deltaY: number): void;
  /** Pan bounded orthographic scenes in screen-pixel deltas. */
  panBy(deltaX: number, deltaY: number): void;
  /** Hit test using CSS-pixel coordinates relative to the canvas top-left. */
  pickAt(x: number, y: number): string | null;
  reset(): void;
  dispose(): void;
}

export function createUniverseRenderer(canvas: HTMLCanvasElement, initialOptions: UniverseRendererOptions): UniverseRenderer {
  const doc = canvas.ownerDocument;
  let options = initialOptions;
  const openingRect = canvas.getBoundingClientRect();
  const openingAspect = openingRect.width > 0 && openingRect.height > 0 ? openingRect.width / openingRect.height : 3.2;
  let projection = options.projection.group === "9"
    ? { ...options.projection, viewportAspect: openingAspect }
    : options.projection;
  let quality = options.quality ?? "auto";
  let effectiveQuality: Exclude<UniverseQuality, "auto" | "off"> = quality === "high" ? "high" : quality === "low" ? "low" : "medium";
  let motion = options.motion ?? true;
  let active = options.active ?? true;
  let inViewport = true;
  let disposed = false;
  let glResources: GLResources | null = null;
  let canvasHasWebGL = false;
  let fallbackCanvas: HTMLCanvasElement | null = null;
  let fallbackContext: CanvasRenderingContext2D | null = null;
  let fallbackOverlay = false;
  let status: "ready" | "fallback" = "ready";
  let frameHandle = 0;
  let lastRenderTime = 0;
  let lastProjectionTime = 0;
  let forceProjectionUpdate = true;
  let slowFrames = 0;
  let fastFramesStarted = 0;
  let width = 1;
  let height = 1;
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let dpr = 1;
  let selectedId: string | null = null;
  let lastProjectionWorks = projection.works;
  let lastProjectionGroup = projection.group;
  let lastProjectionKey = projection.key;
  let layout = buildSceneLayout(projection);
  let lines = layout.lines;
  let nodes = new Map<string, MutableNode>();
  let viewMatrix = identity();
  let projectionMatrix = identity();
  let skyProjectionMatrix = identity();
  let viewProjection = identity();
  let skyViewProjection = identity();
  let cameraRight: [number, number, number] = [1, 0, 0];
  let cameraUp: [number, number, number] = [0, 1, 0];
  let cameraFacing: [number, number, number] = [0, 0, 1];
  let viewFocus: [number, number, number] = [0, 0, 0];
  let fitDistance = layout.cameraDistance;
  let activeScaleTransition: ScaleTransitionState | null = null;
  let transitionLabelsOpacity = 1;
  let transitionEnvironmentMix = 0;
  let transitionFocusMix = 0;
  let labelsHiddenUntil = 0;
  let panX = 0;
  let panY = 0;
  let userAdjusted = false;
  let camera: CameraState = { yaw: layoutYaw(layout), pitch: layoutPitch(layout), yawFrom: layoutYaw(layout), yawTarget: layoutYaw(layout), pitchFrom: layoutPitch(layout), pitchTarget: layoutPitch(layout), orientationStarted: 0, orientationDuration: 0, distance: layout.cameraDistance, targetDistance: layout.cameraDistance, distanceFrom: layout.cameraDistance, distanceStarted: 0, distanceDuration: 0 };
  if (options.initialViewState?.group === projection.group && options.initialViewState.userAdjusted === true) {
    const initial = options.initialViewState;
    camera.yaw = projection.group === "7" ? 0 : Number.isFinite(initial.yaw) ? initial.yaw : layoutYaw(layout);
    camera.pitch = projection.group === "7" ? 0 : clamp(Number.isFinite(initial.pitch) ? initial.pitch : layoutPitch(layout), -1.3, 1.3);
    // The actual fit is known after the layout nodes are created. Keep the saved value
    // here and clamp it against that fit once it is available below.
    camera.distance = Number.isFinite(initial.distance) ? initial.distance : layout.cameraDistance;
    camera.yawFrom = camera.yawTarget = camera.yaw;
    camera.pitchFrom = camera.pitchTarget = camera.pitch;
    camera.distanceFrom = camera.distance;
    camera.targetDistance = camera.distance;
    panX = Number.isFinite(initial.panX) ? initial.panX! : 0;
    panY = Number.isFinite(initial.panY) ? initial.panY! : 0;
    userAdjusted = true;
  }
  let timeline = 0;
  let lastMotionTimestamp = 0;
  let isDragging = false;
  let dragPointerId: number | null = null;
  let pointerX = 0;
  let pointerY = 0;
  let dragDistance = 0;
  let suppressClickUntil = 0;
  let viewStateTimer: number | null = null;
  let observer: IntersectionObserver | null = null;
  let sceneTheme = options.theme;
  let lightMode = 0;
  let backgroundRgb: [number, number, number] = [0.01, 0.01, 0.015];
  let horizonRgb: [number, number, number] = [0.003, 0.004, 0.007];
  const parseColor = parseColorFactory(doc);
  const skySprites = buildSkySprites();
  let statusReported = false;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  function refreshThemeStyle() {
    const [red, green, blue] = parseColor(sceneTheme.background);
    backgroundRgb = [red, green, blue];
    const linear = (value: number) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    lightMode = luminance > 0.30 ? 1 : 0;
    horizonRgb = lightMode
      ? [0.008, 0.009, 0.014]
      : [red * 0.17, green * 0.17, blue * 0.17];
  }
  function themedRgb(color: string): [number, number, number] {
    const [r, g, b] = parseColor(color);
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const delta = maximum - minimum;
    const originalL = (maximum + minimum) * 0.5;
    let hue = 0;
    let saturation = 0;
    if (delta > 0.00001) {
      saturation = delta / (1 - Math.abs(2 * originalL - 1));
      if (maximum === r) hue = ((g - b) / delta) % 6;
      else if (maximum === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    const targetLightness = lightMode ? 0.10 + originalL * 0.22 : 0.68 + originalL * 0.24;
    saturation *= lightMode ? 0.80 : 0.92;
    const chroma = (1 - Math.abs(2 * targetLightness - 1)) * saturation;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = targetLightness - chroma * 0.5;
    let sector: [number, number, number];
    if (hue < 60) sector = [chroma, x, 0];
    else if (hue < 120) sector = [x, chroma, 0];
    else if (hue < 180) sector = [0, chroma, x];
    else if (hue < 240) sector = [0, x, chroma];
    else if (hue < 300) sector = [x, 0, chroma];
    else sector = [chroma, 0, x];
    return [sector[0] + m, sector[1] + m, sector[2] + m];
  }
  const sceneRgba = (color: string, alpha = 1, brightness = 1) => {
    const [red, green, blue] = themedRgb(color);
    return `rgba(${Math.round(clamp(red * brightness, 0, 1) * 255)}, ${Math.round(clamp(green * brightness, 0, 1) * 255)}, ${Math.round(clamp(blue * brightness, 0, 1) * 255)}, ${clamp(alpha, 0, 1)})`;
  };
  const lineAlpha = (alpha: number) => lightMode
    ? clamp(Math.max(alpha * 3.2, 0.60), 0, 0.78)
    : clamp(Math.max(alpha * 3.4, 0.75), 0, 0.88);
  refreshThemeStyle();
  function sceneRadius(sourceLayout: SceneLayout = layout, sourceNodes: Map<string, MutableNode> = nodes): number {
    let radius = 0;
    let foundWork = false;
    for (const node of sourceNodes.values()) {
      if (!node.id || !node.work) continue;
      foundWork = true;
      radius = Math.max(radius, (node.orbitRadius ?? Math.hypot(node.x, node.y, node.z)) + node.size);
    }
    return foundWork ? radius : Math.max(5, sourceLayout.cameraDistance * 0.52);
  }
  function fittedDistance(
    sourceLayout: SceneLayout = layout,
    sourceNodes: Map<string, MutableNode> = nodes,
    yaw = layoutYaw(sourceLayout),
    pitch = layoutPitch(sourceLayout),
    fovy = Math.PI / 3,
  ): number {
    if (sourceLayout.group === "7") {
      const bounds = sourceLayout.bounds ?? deepBounds(sourceLayout, sourceNodes);
      const spanX = Math.max(1, bounds.maxX - bounds.minX);
      const spanY = Math.max(1, bounds.maxY - bounds.minY);
      // Orthographic half-height: expose a portion of the web at once, with
      // enough unseen extent in both axes for bounded panning to matter.
      return Math.max(0.5, Math.min(spanY * 0.25, spanX / Math.max(0.2, width / Math.max(1, height)) * 0.25));
    }
    const aspect = width / Math.max(1, height);
    const tanX = Math.tan(fovy / 2) * aspect * 0.82;
    const tanY = Math.tan(fovy / 2) * 0.82;
    const rotation = multiply(rotationX(pitch), rotationY(yaw));
    let distance = 4.5;
    let foundWork = false;
    let foundIncludedNode = false;
    const include = (x: number, y: number, z: number, radius: number) => {
      const [rx, ry, rz] = transform(rotation, x, y, z);
      const body = radius * 1.4;
      distance = Math.max(distance, rz + (Math.abs(rx) + body) / tanX, rz + (Math.abs(ry) + body) / tanY);
    };
    for (const node of sourceNodes.values()) {
      const isWork = Boolean(node.id && node.work);
      const isGalaxyDust = sourceLayout.group === "8" && !node.id && node.kind === "star";
      if (!isWork && !isGalaxyDust) continue;
      foundIncludedNode = true;
      foundWork ||= isWork;
      if (node.orbitRadius !== undefined && node.orbitPhase !== undefined) {
        const radius = node.orbitRadius;
        const phase = node.orbitPhase;
        const yScale = node.orbitYScale ?? 0;
        const centerX = node.x - Math.cos(phase) * radius;
        const centerY = node.y - Math.sin(phase) * radius * yScale;
        const centerZ = node.z - Math.sin(phase) * radius;
        for (let step = 0; step < 32; step += 1) {
          const angle = step / 32 * Math.PI * 2;
          include(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius * yScale, centerZ + Math.sin(angle) * radius, node.size);
        }
      } else include(node.x, node.y, node.z, node.size);
    }
    if (!foundIncludedNode || !foundWork) distance = Math.max(distance, sourceLayout.cameraDistance);
    return distance;
  }
  function fitAcrossOrientation(
    sourceLayout: SceneLayout,
    sourceNodes: Map<string, MutableNode>,
    fromYaw: number,
    fromPitch: number,
    toYaw: number,
    toPitch: number,
  ): number {
    const yawDelta = ((toYaw - fromYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    let fit = 0;
    // Group changes can rotate a broad, shallow scene while its objects are fading in.
    // Fit a few points along that path so the layout stays inside the stage throughout.
    for (let step = 0; step <= 8; step += 1) {
      const amount = step / 8;
      fit = Math.max(fit, fittedDistance(sourceLayout, sourceNodes, fromYaw + yawDelta * amount, mix(fromPitch, toPitch, amount)));
    }
    return fit;
  }
  function zoomBounds(): { min: number; max: number } {
    if (layout.group === "7") return { min: Math.max(0.05, fitDistance * 0.12), max: fitDistance };
    return { min: Math.max(1.6, fitDistance * 0.35), max: fitDistance };
  }
  function deepBounds(sourceLayout: SceneLayout = layout, sourceNodes: Map<string, MutableNode> = nodes): { minX: number; maxX: number; minY: number; maxY: number } {
    if (sourceLayout.bounds) return sourceLayout.bounds;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of sourceNodes.values()) {
      if (!node.id || !node.work) continue;
      const halfWidth = Math.max(1.15, Math.min(4, (node.work.shortLabel || node.work.title).length * 6 / 74));
      minX = Math.min(minX, node.x - halfWidth);
      maxX = Math.max(maxX, node.x + halfWidth);
      minY = Math.min(minY, node.y - 0.42);
      maxY = Math.max(maxY, node.y + 0.42);
    }
    if (!Number.isFinite(minX)) return { minX: -8, maxX: 8, minY: -5, maxY: 5 };
    return { minX, maxX, minY, maxY };
  }
  function clampDeepPan(): void {
    if (layout.group !== "7") return;
    const bounds = deepBounds(layout, nodes);
    const halfHeight = Math.max(0.1, camera.distance);
    const halfWidth = halfHeight * width / Math.max(1, height);
    const centerX = (bounds.minX + bounds.maxX) * 0.5;
    const centerY = (bounds.minY + bounds.maxY) * 0.5;
    panX = bounds.maxX - bounds.minX <= halfWidth * 2
      ? centerX
      : clamp(panX, bounds.minX + halfWidth, bounds.maxX - halfWidth);
    panY = bounds.maxY - bounds.minY <= halfHeight * 2
      ? centerY
      : clamp(panY, bounds.minY + halfHeight, bounds.maxY - halfHeight);
  }
  function asteroidHalfSpan(): number {
    const aspect = width / Math.max(1, height);
    const halfAngle = Math.atan(Math.tan(Math.PI / 6) * aspect);
    return Math.max(4, fitDistance * Math.tan(halfAngle) * 0.96);
  }

  function setStatus(next: "ready" | "fallback") {
    if (status === next && statusReported) return;
    status = next;
    statusReported = true;
    options.onStatus?.(next);
  }
  function getViewState(): UniverseViewState {
    return {
      group: projection.group,
      yaw: projection.group === "7" ? 0 : camera.yaw,
      pitch: projection.group === "7" ? 0 : camera.pitch,
      distance: camera.distance,
      userAdjusted,
      ...(projection.group === "7" ? { panX, panY } : {}),
    };
  }
  function flushViewState() {
    if (viewStateTimer !== null) window.clearTimeout(viewStateTimer);
    viewStateTimer = null;
    options.onViewStateChange?.(getViewState());
  }
  function scheduleViewStateChange(delay = 140) {
    if (!options.onViewStateChange) return;
    if (viewStateTimer !== null) window.clearTimeout(viewStateTimer);
    viewStateTimer = window.setTimeout(() => {
      viewStateTimer = null;
      options.onViewStateChange?.(getViewState());
    }, delay);
  }
  function makeFallbackOverlay(): CanvasRenderingContext2D | null {
    if (fallbackContext) return fallbackContext;
    if (!canvasHasWebGL && quality !== "off") {
      fallbackCanvas = canvas;
      fallbackContext = canvas.getContext("2d", { alpha: true });
      return fallbackContext;
    }
    fallbackCanvas = doc.createElement("canvas");
    fallbackCanvas.className = `${canvas.className} universe-renderer-fallback`;
    fallbackCanvas.setAttribute("aria-hidden", "true");
    fallbackCanvas.style.position = "absolute";
    fallbackCanvas.style.inset = "0";
    fallbackCanvas.style.width = "100%";
    fallbackCanvas.style.height = "100%";
    fallbackCanvas.style.pointerEvents = "none";
    canvas.insertAdjacentElement("afterend", fallbackCanvas);
    fallbackOverlay = true;
    return (fallbackContext = fallbackCanvas.getContext("2d", { alpha: true }));
  }
  function removeFallbackOverlay() {
    if (fallbackOverlay) fallbackCanvas?.remove();
    fallbackCanvas = null;
    fallbackContext = null;
    fallbackOverlay = false;
  }
  function initializeGL(): boolean {
    try {
      const context = canvas.getContext("webgl", { alpha: false, antialias: true, depth: true, powerPreference: "low-power" });
      if (!context) return false;
      canvasHasWebGL = true;
      glResources = makeGLResources(context);
      canvas.style.visibility = "visible";
      if (quality === "off") {
        makeFallbackOverlay();
        setStatus("fallback");
      } else {
        removeFallbackOverlay();
        setStatus("ready");
      }
      return true;
    } catch {
      glResources = null;
      return false;
    }
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width || canvas.clientWidth || 1);
    height = Math.max(1, rect.height || canvas.clientHeight || 1);
    if (width !== lastCanvasWidth || height !== lastCanvasHeight) {
      lastCanvasWidth = width;
      lastCanvasHeight = height;
      forceProjectionUpdate = true;
    }
    const pixelRatioCap = effectiveQuality === "high" ? 2 : effectiveQuality === "low" ? 1 : 1.5;
    dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), pixelRatioCap);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (fallbackCanvas && fallbackCanvas !== canvas) {
      fallbackCanvas.width = pixelWidth;
      fallbackCanvas.height = pixelHeight;
    }
    if (glResources) glResources.gl.viewport(0, 0, canvas.width, canvas.height);
    const aspect = width / Math.max(1, height);
    const sceneDepth = sceneRadius() * 2 + 200;
    const far = Math.max(900, camera.distance * 2 + sceneDepth);
    skyProjectionMatrix = perspective(Math.PI / 3, aspect, 0.005, 1200);
    projectionMatrix = layout.group === "7" && !activeScaleTransition
      ? orthographic(-camera.distance * aspect, camera.distance * aspect, -camera.distance, camera.distance, 0.1, 300)
      : perspective(activeScaleTransition?.wideFov ? TRANSITION_FOV : Math.PI / 3, aspect, 0.005, far);
    clampDeepPan();
  }

  function nodeKey(object: LayoutObject): string { return object.id ?? `decorative:${object.kind}:${object.seed}`; }
  function makeImmediateNodes(scene: SceneLayout, currentTime: number): Map<string, MutableNode> {
    return new Map(scene.objects.map((object) => {
      const key = nodeKey(object);
      return [key, { ...object, key, currentX: object.x, currentY: object.y, currentZ: object.z, fromX: object.x, fromY: object.y, fromZ: object.z, startTime: currentTime, transitionDuration: 0, opacity: object.alpha, targetAlpha: object.alpha, fadingOut: false }];
    }));
  }
  function sameSceneGeometry(first: Map<string, MutableNode>, second: Map<string, MutableNode>): boolean {
    if (first.size !== second.size) return false;
    const sameNumber = (a: number | undefined, b: number | undefined) =>
      a === undefined || b === undefined ? a === b : Math.abs(a - b) < 0.0001;
    for (const [key, before] of first) {
      const after = second.get(key);
      if (!after || before.kind !== after.kind) return false;
      if (!sameNumber(before.x, after.x) || !sameNumber(before.y, after.y) || !sameNumber(before.z, after.z) || !sameNumber(before.size, after.size)) return false;
      if (!sameNumber(before.orbitRadius, after.orbitRadius) || !sameNumber(before.orbitSpeed, after.orbitSpeed) || !sameNumber(before.orbitPhase, after.orbitPhase) || !sameNumber(before.orbitYScale, after.orbitYScale)) return false;
      if (!sameNumber(before.driftX, after.driftX) || !sameNumber(before.driftY, after.driftY)) return false;
    }
    return true;
  }
  function bridgePosition(sourceNodes: Map<string, MutableNode>, sourceProjection: UniverseProjection): [number, number, number] {
    const works = [...sourceNodes.values()].filter((node) => node.id && node.work && (!sourceProjection.visibleIds || sourceProjection.visibleIds.has(node.id)));
    if (!works.length) return [0, 0, 0];
    const positions = works.map((node) => shiftedPosition(node, timeline, asteroidHalfSpan()));
    const bounds = [0, 1, 2].map((axis) => ({
      min: Math.min(...positions.map((point) => point[axis])),
      max: Math.max(...positions.map((point) => point[axis])),
    }));
    const axes = [0, 1, 2].sort((a, b) => (bounds[b].max - bounds[b].min) - (bounds[a].max - bounds[a].min)).slice(0, 2);
    const center = bounds.map((range) => (range.min + range.max) * 0.5);
    const spanA = Math.max(1, bounds[axes[0]].max - bounds[axes[0]].min);
    const spanB = Math.max(1, bounds[axes[1]].max - bounds[axes[1]].min);
    let best = center as [number, number, number];
    let bestScore = -Infinity;
    // Camera transitions fly through an empty pocket near the center of the layout,
    // never through the selected work or the brightest ranked object.
    for (let row = -6; row <= 6; row += 1) {
      for (let column = -6; column <= 6; column += 1) {
        const candidate = [...center] as [number, number, number];
        candidate[axes[0]] += row / 12 * spanA * 0.62;
        candidate[axes[1]] += column / 12 * spanB * 0.62;
        const clearance = Math.min(...positions.map((point, index) => Math.hypot(
          candidate[0] - point[0], candidate[1] - point[1], candidate[2] - point[2],
        ) - works[index].size * 1.8));
        const centered = Math.hypot(candidate[0] - center[0], candidate[1] - center[1], candidate[2] - center[2]);
        const score = clearance - centered * 0.055;
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
    }
    return best;
  }
  function installLayout(nextProjection: UniverseProjection, immediate = false) {
    const nextLayout = buildSceneLayout(nextProjection);
    const currentTime = now();
    if (activeScaleTransition) {
      activeScaleTransition = null;
      viewFocus = [0, 0, 0];
      transitionLabelsOpacity = 1;
    }
    const oldNodes = nodes;
    const updated = new Map<string, MutableNode>();
    const targetNodes = makeImmediateNodes(nextLayout, currentTime);
    const groupChanged = layout.group !== nextLayout.group;
    const geometryUnchanged = sameSceneGeometry(oldNodes, targetNodes);
    const targetYaw = groupChanged ? layoutYaw(nextLayout) : camera.yaw;
    const targetPitch = groupChanged ? layoutPitch(nextLayout) : camera.pitch;
    const wideFov = layout.group === "7" || nextLayout.group === "7";
    const sourceFit = fittedDistance(layout, oldNodes, camera.yaw, camera.pitch);
    const sourceTransitionFit = wideFov
      ? fittedDistance(layout, oldNodes, camera.yaw, camera.pitch, TRANSITION_FOV)
      : sourceFit;
    const sourceTransitionDistance = wideFov && layout.group !== "7"
      ? camera.distance * TRANSITION_FIT_RATIO
      : camera.distance;
    const settledTargetFit = fittedDistance(nextLayout, targetNodes, targetYaw, targetPitch);
    const targetTransitionFit = wideFov && nextLayout.group !== "7"
      ? settledTargetFit * TRANSITION_FIT_RATIO
      : settledTargetFit;
    const sourcePan: [number, number] = layout.group === "7" ? [panX, panY] : [0, 0];
    const targetPan: [number, number] = nextLayout.group === "7" && nextLayout.bounds
      ? [(nextLayout.bounds.minX + nextLayout.bounds.maxX) * 0.5, (nextLayout.bounds.minY + nextLayout.bounds.maxY) * 0.5]
      : [0, 0];
    const scalePlan = immediate || quality === "off" || !motion
      ? null
      : createScaleTransition(layout.group, nextLayout.group, sourceTransitionFit, targetTransitionFit, sourceTransitionDistance);
    const targetFit = scalePlan
      ? fittedDistance(nextLayout, targetNodes, targetYaw, targetPitch)
      : groupChanged
        ? fitAcrossOrientation(nextLayout, targetNodes, camera.yaw, camera.pitch, targetYaw, targetPitch)
        : fittedDistance(nextLayout, targetNodes, targetYaw, targetPitch);
    if (scalePlan) {
      camera.orientationDuration = 0;
      activeScaleTransition = {
        plan: scalePlan,
        startedAt: currentTime,
        sourceNodes: oldNodes,
        incomingNodes: targetNodes,
        incomingLayout: nextLayout,
        incomingProjection: nextProjection,
        sourceBridge: bridgePosition(oldNodes, projection),
        targetBridge: bridgePosition(targetNodes, nextProjection),
        sourceYaw: camera.yaw,
        targetYaw,
        sourcePitch: camera.pitch,
        targetPitch,
        settledTargetFit,
        sourcePan,
        targetPan,
        wideFov,
        switched: false,
      };
      labelsHiddenUntil = currentTime + scalePlan.duration;
      camera.distance = sourceTransitionDistance;
      camera.distanceFrom = sourceTransitionDistance;
      camera.targetDistance = sourceTransitionDistance;
      camera.distanceStarted = currentTime;
      camera.distanceDuration = 0;
      fitDistance = sourceTransitionFit;
      lastProjectionWorks = nextProjection.works;
      lastProjectionGroup = nextProjection.group;
      lastProjectionKey = nextProjection.key;
      scheduleViewStateChange(scalePlan.duration + 50);
      ensureFrame();
      return;
    }

    const transitionDuration = immediate || quality === "off" || status === "fallback" ? 0 : !motion ? 120 : 430;
    labelsHiddenUntil = transitionDuration > 0 ? currentTime + transitionDuration : currentTime;
    for (const object of nextLayout.objects) {
      const key = nodeKey(object);
      const existing = oldNodes.get(key);
      const [x, y, z] = existing ? shiftedPosition(existing, timeline, asteroidHalfSpan()) : [object.x, object.y, object.z];
      updated.set(key, {
        ...object,
        key,
        currentX: x,
        currentY: y,
        currentZ: z,
        fromX: x,
        fromY: y,
        fromZ: z,
        startTime: currentTime,
        transitionDuration,
        opacity: existing?.opacity ?? 0,
        targetAlpha: object.alpha,
        fadingOut: false,
      });
    }
    if (transitionDuration > 0) {
      for (const [key, old] of oldNodes) {
        if (updated.has(key)) continue;
        updated.set(key, { ...old, fromX: old.currentX, fromY: old.currentY, fromZ: old.currentZ, startTime: currentTime, transitionDuration, targetAlpha: 0, fadingOut: true });
      }
    }
    nodes = updated;
    layout = nextLayout;
    lines = nextLayout.lines;
    if (groupChanged) {
      userAdjusted = false;
      if (nextLayout.group === "7") {
        const bounds = deepBounds(nextLayout, nodes);
        panX = (bounds.minX + bounds.maxX) * 0.5;
        panY = (bounds.minY + bounds.maxY) * 0.5;
      } else {
        panX = panY = 0;
      }
    }
    camera.yawFrom = camera.yaw;
    camera.yawTarget = targetYaw;
    camera.pitchFrom = camera.pitch;
    camera.pitchTarget = targetPitch;
    camera.orientationStarted = currentTime;
    camera.orientationDuration = groupChanged ? transitionDuration : 0;
    if (!camera.orientationDuration) {
      camera.yaw = targetYaw;
      camera.pitch = targetPitch;
    }
    fitDistance = targetFit;
    camera.distanceFrom = camera.distance;
    const targetBounds = zoomBounds();
    camera.targetDistance = groupChanged
      ? targetFit
      : geometryUnchanged
        ? camera.distance
        : clamp((sourceFit > 0 ? camera.distance / sourceFit : 1) * targetFit, targetBounds.min, targetBounds.max);
    camera.distanceStarted = currentTime;
    camera.distanceDuration = groupChanged || !geometryUnchanged ? transitionDuration : 0;
    lastProjectionWorks = nextProjection.works;
    lastProjectionGroup = nextProjection.group;
    lastProjectionKey = nextProjection.key;
    projection = nextProjection;
    const bounds = zoomBounds();
    camera.targetDistance = clamp(camera.targetDistance, bounds.min, bounds.max);
    clampDeepPan();
    scheduleViewStateChange(transitionDuration + 40);
    ensureFrame();
  }

  function setNodePositions(time: number): void {
    for (const [key, node] of [...nodes]) {
      const amount = node.transitionDuration === 0 ? 1 : clamp((time - node.startTime) / node.transitionDuration, 0, 1);
      const eased = smooth(amount);
      const targetX = node.fadingOut ? node.fromX : node.x;
      const targetY = node.fadingOut ? node.fromY : node.y;
      const targetZ = node.fadingOut ? node.fromZ : node.z;
      node.currentX = mix(node.fromX, targetX, eased);
      node.currentY = mix(node.fromY, targetY, eased);
      node.currentZ = mix(node.fromZ, targetZ, eased);
      node.opacity = mix(node.opacity, node.targetAlpha, eased);
      if (amount >= 1 && node.fadingOut) nodes.delete(key);
    }
    if (camera.orientationDuration > 0) {
      const amount = clamp((time - camera.orientationStarted) / camera.orientationDuration, 0, 1);
      const eased = smooth(amount);
      const yawDelta = ((camera.yawTarget - camera.yawFrom + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      camera.yaw = camera.yawFrom + yawDelta * eased;
      camera.pitch = mix(camera.pitchFrom, camera.pitchTarget, eased);
      if (amount >= 1) {
        camera.yaw = camera.yawTarget;
        camera.pitch = camera.pitchTarget;
        camera.orientationDuration = 0;
        fitDistance = fittedDistance(layout, nodes, camera.yaw, camera.pitch);
        const bounds = zoomBounds();
        if (camera.targetDistance > bounds.max) {
          camera.distanceFrom = camera.distance;
          camera.targetDistance = bounds.max;
          camera.distanceStarted = time;
          camera.distanceDuration = 190;
        }
      }
    }
    const distanceAmount = camera.distanceDuration === 0 ? 1 : clamp((time - camera.distanceStarted) / camera.distanceDuration, 0, 1);
    camera.distance = mix(camera.distanceFrom, camera.targetDistance, smooth(distanceAmount));
  }
  function calculateView(): void {
    if (projection.group === "7") {
      if (!activeScaleTransition) {
        camera.yaw = 0;
        camera.pitch = 0;
      }
      if (activeScaleTransition?.wideFov) {
        const state = activeScaleTransition;
        let centerX = panX;
        let centerY = panY;
        if (state.plan.from === "7") {
          centerX = mix(state.sourcePan[0], state.sourceBridge[0], transitionFocusMix);
          centerY = mix(state.sourcePan[1], state.sourceBridge[1], transitionFocusMix);
        } else if (state.plan.to === "7") {
          centerX = mix(state.targetPan[0], state.targetBridge[0], transitionFocusMix);
          centerY = mix(state.targetPan[1], state.targetBridge[1], transitionFocusMix);
        }
        // A 90° perspective camera at z=-distance has the same scale as the
        // settled Deep Field orthographic camera with that half-height.
        viewMatrix = translation(-centerX, -centerY, -camera.distance);
      } else {
        viewMatrix = translation(-panX, -panY, -100);
      }
      viewProjection = multiply(projectionMatrix, viewMatrix);
      const skyRotation = activeScaleTransition
        ? multiply(rotationX(camera.pitch), rotationY(camera.yaw))
        : identity();
      skyViewProjection = multiply(skyProjectionMatrix, skyRotation);
      cameraRight = [1, 0, 0];
      cameraUp = [0, 1, 0];
      cameraFacing = [0, 0, 1];
      return;
    }
    const rotation = multiply(rotationX(camera.pitch), rotationY(camera.yaw));
    const focusTranslation = translation(-viewFocus[0], -viewFocus[1], -viewFocus[2]);
    viewMatrix = multiply(translation(0, 0, -camera.distance), multiply(rotation, focusTranslation));
    viewProjection = multiply(projectionMatrix, viewMatrix);
    skyViewProjection = multiply(skyProjectionMatrix, rotation);
    cameraRight = [Math.cos(camera.yaw), 0, Math.sin(camera.yaw)];
    cameraUp = [Math.sin(camera.pitch) * Math.sin(camera.yaw), Math.cos(camera.pitch), -Math.sin(camera.pitch) * Math.cos(camera.yaw)];
    cameraFacing = [-Math.sin(camera.yaw) * Math.cos(camera.pitch), Math.sin(camera.pitch), Math.cos(camera.yaw) * Math.cos(camera.pitch)];
  }
  function advanceScaleTransition(time: number): void {
    const state = activeScaleTransition;
    if (!state) {
      transitionLabelsOpacity = 1;
      transitionEnvironmentMix = 0;
      transitionFocusMix = 0;
      viewFocus = [0, 0, 0];
      return;
    }
    const elapsed = (status !== "ready" && status !== "fallback") || quality === "off" || !motion
      ? state.plan.duration
      : time - state.startedAt;
    const progress = clamp(elapsed / state.plan.duration, 0, 1);
    const frame = sampleScaleTransition(state.plan, elapsed);
    // Deep Field is genuinely orthographic and face-on. Move the source pose
    // onto that plane before handing off to 7; when leaving 7, let the new
    // perspective galaxy open from the tiny bridge point as its tilt returns.
    const turn = state.plan.to === "7"
      ? smooth(clamp(progress / TRANSITION_HANDOFF, 0, 1))
      : state.plan.from === "7"
        ? smooth(clamp((progress - TRANSITION_HANDOFF) / (1 - TRANSITION_HANDOFF), 0, 1))
        : smooth(progress);
    const yawDelta = ((state.targetYaw - state.sourceYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    camera.yaw = state.sourceYaw + yawDelta * turn;
    camera.pitch = mix(state.sourcePitch, state.targetPitch, turn);
    camera.distance = frame.distance;
    transitionLabelsOpacity = frame.labelsOpacity;
    transitionEnvironmentMix = frame.environmentMix;
    transitionFocusMix = frame.focusMix;
    if (frame.phase === "incoming" && !state.switched) {
      nodes = state.incomingNodes;
      layout = state.incomingLayout;
      lines = state.incomingLayout.lines;
      projection = state.incomingProjection;
      state.switched = true;
      fitDistance = state.plan.targetFit;
      forceProjectionUpdate = true;
    }
    const focus = frame.phase === "outgoing" && !state.plan.outward
      ? state.sourceBridge.map((value) => value * frame.focusMix) as [number, number, number]
      : frame.phase === "incoming" && state.plan.outward
        ? state.targetBridge.map((value) => value * frame.focusMix) as [number, number, number]
        : [0, 0, 0] as [number, number, number];
    viewFocus = focus;
    if (frame.phase === "complete") {
      if (!state.switched) {
        nodes = state.incomingNodes;
        layout = state.incomingLayout;
        lines = state.incomingLayout.lines;
        projection = state.incomingProjection;
      }
      camera.distance = state.settledTargetFit;
      // The next animation tick always re-evaluates distance from the tween state.
      // Commit all three values so it cannot snap back to the pre-transition camera.
      camera.distanceFrom = state.settledTargetFit;
      camera.targetDistance = state.settledTargetFit;
      camera.distanceStarted = time;
      camera.distanceDuration = 0;
      camera.yaw = state.targetYaw;
      camera.pitch = state.targetPitch;
      camera.yawFrom = camera.yawTarget = camera.yaw;
      camera.pitchFrom = camera.pitchTarget = camera.pitch;
      camera.orientationDuration = 0;
      viewFocus = [0, 0, 0];
      transitionFocusMix = 0;
      if (state.plan.to === "7") {
        panX = state.targetPan[0];
        panY = state.targetPan[1];
      } else if (state.plan.from === "7") {
        panX = panY = 0;
      }
      userAdjusted = false;
      labelsHiddenUntil = time;
      transitionLabelsOpacity = 1;
      transitionEnvironmentMix = 0;
      fitDistance = state.settledTargetFit;
      activeScaleTransition = null;
      forceProjectionUpdate = true;
    }
  }
  function projected(node: MutableNode, time: number): { x: number; y: number; depth: number; size: number; visible: boolean } {
    const [worldX, worldY, worldZ] = shiftedPosition(node, time, asteroidHalfSpan());
    const [clipX, clipY, clipZ, clipW] = transform(viewProjection, worldX, worldY, worldZ);
    if (clipW <= 0.005) return { x: -1000, y: -1000, depth: 1, size: 0, visible: false };
    const nx = clipX / clipW;
    const ny = clipY / clipW;
    const nz = clipZ / clipW;
    const x = (nx * 0.5 + 0.5) * width;
    const y = (1 - (ny * 0.5 + 0.5)) * height;
    const currentFov = activeScaleTransition?.wideFov ? TRANSITION_FOV : Math.PI / 3;
    const focalPixels = height / (2 * Math.tan(currentFov / 2));
    const constellationWorkStar = projection.group === "9" && Boolean(node.id && node.work) && node.kind === "star";
    const visualDiameter = constellationWorkStar
      ? constellationWorldSize(node) * 2 * focalPixels / clipW * 0.82
      : node.size * 2 * focalPixels / clipW;
    const size = projection.group === "7"
      ? node.size * height / Math.max(0.1, camera.distance)
      : visualDiameter;
    return { x, y, depth: clamp(nz * 0.5 + 0.5, 0, 1), size, visible: nx >= -1.08 && nx <= 1.08 && ny >= -1.08 && ny <= 1.08 && node.opacity > 0.08 };
  }
  function selectedVisible(node: MutableNode): boolean {
    return Boolean(node.id && (!projection.visibleIds || projection.visibleIds.has(node.id)));
  }
  function sceneWorkNodes(): MutableNode[] {
    return [...nodes.values()].filter((node) => node.id && node.work && selectedVisible(node));
  }
  function sunWorldPosition(): [number, number, number] {
    const sun = [...nodes.values()].find((node) => node.kind === "sun" && node.id && node.work && selectedVisible(node))
      ?? [...nodes.values()].find((node) => node.kind === "sun" && !node.id);
    return sun ? shiftedPosition(sun, timeline, asteroidHalfSpan()) : [0, 0, 0];
  }
  function constellationWorldSize(node: MutableNode): number {
    if (projection.group !== "9" || !node.id || !node.work || node.kind !== "star") return node.size;
    const defaultFocal = height / (2 * Math.tan(Math.PI / 6));
    // The shader's colored core occupies about 82% of the quad diameter.
    // Set a physical world-size floor that resolves to a 5.5px core at fit;
    // zooming still scales the star naturally with the camera.
    return Math.max(node.size, (5.5 * fitDistance) / (2 * defaultFocal * 0.82));
  }
  function buildQuadData(objects: readonly (MutableNode | SkySprite)[], time: number, opacityScale = 1, limit?: number, opaqueHorizon = false): Float32Array {
    const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    const selected = limit === undefined ? objects : objects.slice(0, limit);
    const data = new Float32Array(selected.length * 6 * 12);
    let offset = 0;
    for (const node of selected) {
      if ("currentX" in node && node.id && node.work && !selectedVisible(node)) continue;
      if (node.kind === "nebula") continue;
      const [x, y, z] = "currentX" in node ? shiftedPosition(node, time, asteroidHalfSpan()) : [node.x, node.y, node.z];
      const palette = "work" in node ? node.work?.palette : undefined;
      let color = node.color;
      if ("id" in node && node.id && node.work) {
        if (node.kind === "asteroid") color = "#858b93";
        else {
          if (node.kind === "planet" || node.kind === "galaxy") color = palette?.dominant ?? palette?.vibrant ?? color;
          else color = palette?.vibrant ?? palette?.accent ?? color;
          if (node.id === selectedId) color = palette?.lightVibrant ?? palette?.accent ?? color;
        }
      }
      const isSkySprite = !("currentX" in node);
      const skyStar = isSkySprite && node.kind === "star";
      const skyGalaxy = isSkySprite && node.kind === "galaxy";
      if (skyStar) color = lightMode ? "#050508" : "#f4f6ff";
      let adjusted: [number, number, number] = skyStar
        ? lightMode ? [0, 0, 0] : [0.96, 0.98, 1]
        : themedRgb(color);
      if (projection.group === "7" && "work" in node && node.work && node.kind === "galaxy") {
        adjusted = [Math.min(1, adjusted[0] * 1.55), Math.min(1, adjusted[1] * 1.55), Math.min(1, adjusted[2] * 1.55)];
      }
      const baseAlpha = ("opacity" in node ? node.opacity : node.alpha) * opacityScale;
      const alpha = opaqueHorizon && (node.kind === "blackHole" || node.kind === "sun")
        ? 1
        : skyStar ? opacityScale : node.kind === "planet" ? Math.min(1, baseAlpha * 1.18) : baseAlpha;
      const chosen: [number, number, number, number] = [adjusted[0], adjusted[1], adjusted[2], clamp(alpha, 0, 1)];
      const physicalScale = node.kind === "planet" ? 1.4 : 1;
      // Clip W is positive in front of the camera; using rotated Z here
      // reversed that sign and reduced visible background galaxies to specks.
      const skyDepth = transform(skyViewProjection, x, y, z)[3];
      const baseSize = skyStar
        ? 2 * (lightMode ? 2.8 : 1.25) * Math.tan(Math.PI / 6) * Math.max(1, skyDepth) / height
        : !isSkySprite && "currentX" in node ? constellationWorldSize(node) : node.size;
      const size = ("id" in node && node.id === selectedId ? baseSize * 1.08 : baseSize) * physicalScale;
      const constellationWorkStar = !isSkySprite && projection.group === "9" && "id" in node && Boolean(node.id && node.work) && node.kind === "star";
      for (const [cornerX, cornerY] of corners) {
        data[offset++] = x;
        data[offset++] = y;
        data[offset++] = z;
        data[offset++] = chosen[0];
        data[offset++] = chosen[1];
        data[offset++] = chosen[2];
        data[offset++] = chosen[3];
        data[offset++] = size;
        data[offset++] = skyStar ? SKY_STAR_KIND_CODE : skyGalaxy ? SKY_GALAXY_KIND_CODE : constellationWorkStar ? CONSTELLATION_STAR_KIND_CODE : spriteKindCode(node.kind);
        data[offset++] = (node.seed % 1000) / 1000;
        data[offset++] = cornerX;
        data[offset++] = cornerY;
      }
    }
    return data.subarray(0, offset);
  }
  function buildLensingData(): Float32Array {
    if (projection.group !== "dropped") return new Float32Array();
    const hole = [...nodes.values()].find((node) => node.kind === "blackHole");
    if (!hole) return new Float32Array();
    const center = shiftedPosition(hole, timeline, asteroidHalfSpan());
    const radius = hole.size * 0.86;
    const lift = hole.size * 0.035;
    const color = themedRgb("#ffe1a1");
    const alpha = lightMode ? 0.62 : 0.94;
    const output: number[] = [];
    const arcSpecs: Array<[number, number, number]> = [[0.12 * Math.PI, 0.88 * Math.PI, 1], [1.12 * Math.PI, 1.88 * Math.PI, 0.74]];
    for (const [start, end, brightness] of arcSpecs) {
      const segments = 44;
      let previous: [number, number, number] | null = null;
      for (let index = 0; index <= segments; index += 1) {
        const angle = mix(start, end, index / segments);
        const side = Math.cos(angle) * radius * 1.28;
        const vertical = Math.sin(angle) * radius * 0.68;
        const point: [number, number, number] = [
          center[0] + cameraRight[0] * side + cameraUp[0] * vertical + cameraFacing[0] * lift,
          center[1] + cameraRight[1] * side + cameraUp[1] * vertical + cameraFacing[1] * lift,
          center[2] + cameraRight[2] * side + cameraUp[2] * vertical + cameraFacing[2] * lift,
        ];
        if (previous) {
          const fade = Math.sin(Math.PI * index / segments) * brightness;
          output.push(...previous, color[0], color[1], color[2], alpha * fade);
          output.push(...point, color[0], color[1], color[2], alpha * fade);
        }
        previous = point;
      }
    }
    return new Float32Array(output);
  }
  function buildLineData(time: number): Float32Array {
    const output: number[] = [];
    for (const shape of projection.group === "10" || projection.group === "dropped" ? [] : lines) {
      const pointCount = shape.points.length;
      if (pointCount < 2) continue;
      const rgb = themedRgb(shape.color);
      const color: [number, number, number, number] = [rgb[0], rgb[1], rgb[2], lineAlpha(shape.alpha)];
      const segmentCount = pointCount - 1;
      for (let index = 0; index < segmentCount; index += 1) {
        const first = shape.points[index];
        const second = shape.points[index + 1];
        output.push(first[0], first[1], first[2], ...color, second[0], second[1], second[2], ...color);
      }
    }
    // A short path of fading light follows each moving world; no full schematic orbit is drawn.
    if (projection.group === "10" || projection.group === "dropped") {
      for (const node of nodes.values()) {
        if (node.kind !== "planet" || !node.orbitRadius || node.orbitSpeed === undefined || node.orbitPhase === undefined) continue;
        if (node.id && !selectedVisible(node)) continue;
        const color = themedRgb(node.color);
        const speedSign = Math.sign(node.orbitSpeed) || 1;
        const current = node.orbitPhase + time * node.orbitSpeed;
        const segments = 18;
        for (let step = 0; step < segments; step += 1) {
          const firstAngle = current - speedSign * (step / segments) * 0.62;
          const secondAngle = current - speedSign * ((step + 1) / segments) * 0.62;
          const trailStrength = lightMode ? 0.48 : 0.34;
          const firstAlpha = (1 - step / segments) * trailStrength * node.opacity;
          const secondAlpha = (1 - (step + 1) / segments) * trailStrength * node.opacity;
          const first = [Math.cos(firstAngle) * node.orbitRadius, node.currentY, Math.sin(firstAngle) * node.orbitRadius];
          const second = [Math.cos(secondAngle) * node.orbitRadius, node.currentY, Math.sin(secondAngle) * node.orbitRadius];
          output.push(first[0], first[1], first[2], color[0], color[1], color[2], firstAlpha);
          output.push(second[0], second[1], second[2], color[0], color[1], color[2], secondAlpha);
        }
      }
    }
    return new Float32Array(output);
  }
  function uploadAttribute(gl: WebGLRenderingContext, buffer: WebGLBuffer, info: GLProgramInfo, data: Float32Array, billboard: boolean) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = billboard ? 12 * 4 : 7 * 4;
    gl.enableVertexAttribArray(info.position);
    gl.vertexAttribPointer(info.position, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(info.color);
    gl.vertexAttribPointer(info.color, 4, gl.FLOAT, false, stride, 3 * 4);
    if (billboard) {
      gl.enableVertexAttribArray(info.size!);
      gl.vertexAttribPointer(info.size!, 1, gl.FLOAT, false, stride, 7 * 4);
      gl.enableVertexAttribArray(info.kind!);
      gl.vertexAttribPointer(info.kind!, 1, gl.FLOAT, false, stride, 8 * 4);
      gl.enableVertexAttribArray(info.seed!);
      gl.vertexAttribPointer(info.seed!, 1, gl.FLOAT, false, stride, 9 * 4);
      gl.enableVertexAttribArray(info.corner!);
      gl.vertexAttribPointer(info.corner!, 2, gl.FLOAT, false, stride, 10 * 4);
    }
  }
  function drawWebGL(_time: number) {
    if (!glResources) return;
    const { gl, billboard, line, billboardBuffer, lineBuffer } = glResources;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(backgroundRgb[0], backgroundRgb[1], backgroundRgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const qualityStars = effectiveQuality === "low" ? 480 : effectiveQuality === "high" ? 1500 : 1000;
    let sourceGalaxy = projection.group === "8";
    let targetGalaxy = sourceGalaxy;
    let sourceStars = projection.group !== "7" && projection.group !== "8" ? 1 : 0;
    let targetStars = sourceStars;
    if (activeScaleTransition) {
      sourceGalaxy = activeScaleTransition.plan.from === "8";
      targetGalaxy = activeScaleTransition.plan.to === "8";
      sourceStars = activeScaleTransition.plan.from !== "7" && activeScaleTransition.plan.from !== "8" ? 1 : 0;
      targetStars = activeScaleTransition.plan.to !== "7" && activeScaleTransition.plan.to !== "8" ? 1 : 0;
    }
    const galaxyMix = activeScaleTransition ? (sourceGalaxy === targetGalaxy ? Number(targetGalaxy) : mix(Number(sourceGalaxy), Number(targetGalaxy), transitionEnvironmentMix)) : Number(sourceGalaxy);
    const starMix = activeScaleTransition && sourceStars !== targetStars
      ? mix(sourceStars, targetStars, transitionEnvironmentMix)
      : targetStars;
    const renderBillboards = (data: Float32Array, matrix: Matrix, pass: 0 | 1 | 2) => {
      if (!data.length) return;
      gl.useProgram(billboard.program);
      gl.uniformMatrix4fv(billboard.viewProjection, false, matrix);
      gl.uniform3fv(billboard.cameraRight!, cameraRight);
      gl.uniform3fv(billboard.cameraUp!, cameraUp);
      gl.uniform3fv(billboard.cameraFacing!, cameraFacing);
      gl.uniform3fv(billboard.sunPosition!, sunWorldPosition());
      gl.uniform1f(billboard.lightMode!, lightMode);
      gl.uniform3fv(billboard.horizonColor!, horizonRgb);
      gl.uniform1f(billboard.renderPass!, pass);
      uploadAttribute(gl, billboardBuffer, billboard, data, true);
      gl.drawArrays(gl.TRIANGLES, 0, data.length / 12);
    };

    // Environment objects sit on an enormous sphere around the camera. They rotate with the view,
    // ignore camera translation, and never write depth or receive work hit targets.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    const skyStarWeight = starMix;
    if (skyStarWeight > 0) renderBillboards(buildQuadData(skySprites.stars, timeline, skyStarWeight, qualityStars), skyViewProjection, 1);
    if (galaxyMix > 0) renderBillboards(buildQuadData(skySprites.galaxies, timeline, galaxyMix), skyViewProjection, 1);
    gl.enable(gl.DEPTH_TEST);
    const hasVisibleSun = sceneWorkNodes().some((node) => node.kind === "sun");
    const sceneObjects = [...nodes.values()].filter((node) => !(projection.group === "7" && !node.id)
      && node.kind !== "blackHole" && !(projection.group === "10" && node.kind === "sun" && !node.id && hasVisibleSun));
    const sceneData = buildQuadData(sceneObjects, timeline);
    const sunCoreData = buildQuadData(sceneObjects.filter((node) => node.kind === "sun"), timeline, 1, undefined, true);
    const blackHoleObjects = [...nodes.values()].filter((node) => node.kind === "blackHole");
    const blackHoleData = buildQuadData(blackHoleObjects, timeline, 1, undefined, true);
    // Opaque celestial cores establish depth before any translucent glows, so
    // the sun and event horizon occlude objects behind their physical discs.
    gl.depthMask(true);
    renderBillboards(sunCoreData, viewProjection, 2);
    renderBillboards(blackHoleData, viewProjection, 2);
    gl.depthMask(false);
    renderBillboards(blackHoleData, viewProjection, 0);
    renderBillboards(sceneData, viewProjection, 0);
    const lineData = projection.group === "7" ? new Float32Array() : buildLineData(timeline);
    if (lineData.length) {
      gl.useProgram(line.program);
      gl.uniformMatrix4fv(line.viewProjection, false, viewProjection);
      uploadAttribute(gl, lineBuffer, line, lineData, false);
      gl.drawArrays(gl.LINES, 0, lineData.length / 7);
    }
    renderBillboards(sceneData, viewProjection, 1);
    gl.depthMask(true);
    renderBillboards(sceneData, viewProjection, 2);
    gl.depthMask(false);
    const lensingData = buildLensingData();
    if (lensingData.length) {
      gl.useProgram(line.program);
      gl.uniformMatrix4fv(line.viewProjection, false, viewProjection);
      uploadAttribute(gl, lineBuffer, line, lensingData, false);
      gl.drawArrays(gl.LINES, 0, lensingData.length / 7);
    }
    gl.depthMask(true);
  }
  function drawFallback(time: number) {
    const context = fallbackContext ?? makeFallbackOverlay();
    const target = fallbackCanvas ?? canvas;
    if (!context || !target) return;
    if (target.width !== Math.round(width * dpr) || target.height !== Math.round(height * dpr)) resize();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = sceneTheme.background;
    context.fillRect(0, 0, width, height);
    const sourceGalaxy = activeScaleTransition
      ? activeScaleTransition.plan.from === "8"
      : projection.group === "8";
    const targetGalaxy = activeScaleTransition
      ? activeScaleTransition.plan.to === "8"
      : sourceGalaxy;
    const galaxyMix = activeScaleTransition
      ? (sourceGalaxy === targetGalaxy ? Number(targetGalaxy) : mix(Number(sourceGalaxy), Number(targetGalaxy), transitionEnvironmentMix))
      : Number(sourceGalaxy);
    const sourceStars = activeScaleTransition
      ? Number(activeScaleTransition.plan.from !== "7" && activeScaleTransition.plan.from !== "8")
      : Number(projection.group !== "7" && projection.group !== "8");
    const targetStars = activeScaleTransition
      ? Number(activeScaleTransition.plan.to !== "7" && activeScaleTransition.plan.to !== "8")
      : Number(projection.group !== "7" && projection.group !== "8");
    const starMix = activeScaleTransition && sourceStars !== targetStars ? mix(sourceStars, targetStars, transitionEnvironmentMix) : targetStars;
    const drawSky = (sprite: SkySprite, matrix: Matrix, opacity: number) => {
      const [clipX, clipY, , clipW] = transform(matrix, sprite.x, sprite.y, sprite.z);
      if (clipW <= 0.005) return;
      const nx = clipX / clipW, ny = clipY / clipW;
      if (nx < -1.02 || nx > 1.02 || ny < -1.02 || ny > 1.02) return;
      const x = (nx * 0.5 + 0.5) * width;
      const y = (1 - (ny * 0.5 + 0.5)) * height;
      const radius = sprite.kind === "star"
        ? (lightMode ? 1.4 : 0.625)
        : Math.max(0.35, sprite.size * height / (2 * Math.tan(Math.PI / 6) * clipW));
      context.globalAlpha = opacity * (sprite.kind === "star" ? 1 : sprite.alpha);
      context.fillStyle = sprite.kind === "star"
        ? (lightMode ? "#000000" : "#f4f6ff")
        : sceneRgba(sprite.color);
      if (sprite.kind === "galaxy" && sprite.planeU && sprite.planeV) {
        const projectOffset = (axis: [number, number, number]) => {
          const [axisX, axisY, , axisW] = transform(matrix,
            sprite.x + axis[0] * sprite.size,
            sprite.y + axis[1] * sprite.size,
            sprite.z + axis[2] * sprite.size);
          if (axisW <= 0.005) return [0, 0] as const;
          return [
            (axisX / axisW * 0.5 + 0.5) * width - x,
            (1 - (axisY / axisW * 0.5 + 0.5)) * height - y,
          ] as const;
        };
        const u = projectOffset(sprite.planeU);
        const v = projectOffset(sprite.planeV);
        context.save();
        context.transform(u[0], u[1], v[0], v[1], x, y);
        const halo = context.createRadialGradient(0, 0, 0.01, 0, 0, 0.98);
        halo.addColorStop(0, sceneRgba("#fff0d6", 0.48));
        halo.addColorStop(0.16, sceneRgba(sprite.color, 0.24));
        halo.addColorStop(0.56, sceneRgba(sprite.color, 0.09));
        halo.addColorStop(1, sceneRgba(sprite.color, 0));
        context.fillStyle = halo;
        context.beginPath();
        context.arc(0, 0, 0.98, 0, Math.PI * 2);
        context.fill();
        for (let arm = 0; arm < 3; arm += 1) {
          for (let knot = 0; knot < 27; knot += 1) {
            const t = (knot + 0.5) / 27;
            const spiralRadius = 0.08 + t * 0.82;
            const angle = arm * (Math.PI * 2 / 3) + t * Math.PI * 2 * 1.22 + (unit(sprite.seed, arm * 33 + knot) - 0.5) * 0.20;
            const dotRadius = 0.012 + unit(sprite.seed, arm * 67 + knot + 4) * 0.015;
            context.globalAlpha = opacity * sprite.alpha * (0.54 + unit(sprite.seed, knot + arm * 17 + 91) * 0.34);
            context.fillStyle = sceneRgba(sprite.color);
            context.beginPath();
            context.arc(Math.cos(angle) * spiralRadius, Math.sin(angle) * spiralRadius, dotRadius, 0, Math.PI * 2);
            context.fill();
          }
        }
        context.restore();
      } else {
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    const skyMatrix = multiply(skyProjectionMatrix, multiply(rotationX(camera.pitch), rotationY(camera.yaw)));
    if (starMix > 0) for (const sprite of skySprites.stars.slice(0, effectiveQuality === "low" ? 480 : effectiveQuality === "high" ? 1500 : 1000)) drawSky(sprite, skyMatrix, starMix);
    if (galaxyMix > 0) for (const sprite of skySprites.galaxies) drawSky(sprite, skyMatrix, galaxyMix);
    calculateView();
    for (const shape of projection.group === "10" || projection.group === "dropped" || projection.group === "7" ? [] : lines) {
      if (shape.points.length < 2) continue;
      context.beginPath();
      for (const [index, [x, y, z]] of shape.points.entries()) {
        const [clipX, clipY, , clipW] = transform(viewProjection, x, y, z);
        if (clipW <= 0.005) continue;
        const px = (clipX / clipW * 0.5 + 0.5) * width;
        const py = (1 - (clipY / clipW * 0.5 + 0.5)) * height;
        if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
      }
      context.strokeStyle = sceneRgba(shape.color, lineAlpha(shape.alpha));
      context.lineWidth = 1.2;
      context.stroke();
    }
    const drawOrder = [...nodes.values()].sort((a, b) => projected(b, timeline).depth - projected(a, timeline).depth);
    const hasVisibleSun = sceneWorkNodes().some((node) => node.kind === "sun");
    for (const node of drawOrder) {
      if (projection.group === "7" && !node.id) continue;
      if (node.id && !selectedVisible(node)) continue;
      if (projection.group === "10" && node.kind === "sun" && !node.id && hasVisibleSun) continue;
      if (node.kind === "nebula") continue;
      const point = projected(node, timeline);
      if (!point.visible) continue;
      const radius = Math.max(0.6, point.size * 0.5);
      const tint = sceneRgba(node.color, 1, projection.group === "7" && node.id && node.kind === "galaxy" ? 1.55 : 1);
      if (node.kind === "sun" || node.kind === "planet") {
        context.globalAlpha = node.opacity;
        if (node.kind === "planet") {
          const world = shiftedPosition(node, timeline, asteroidHalfSpan());
          const sun = sunWorldPosition();
          const dx = sun[0] - world[0], dy = sun[1] - world[1], dz = sun[2] - world[2];
          const length = Math.max(0.0001, Math.hypot(dx, dy, dz));
          const lx = (dx * cameraRight[0] + dy * cameraRight[1] + dz * cameraRight[2]) / length;
          const ly = (dx * cameraUp[0] + dy * cameraUp[1] + dz * cameraUp[2]) / length;
          const bodyRadius = radius * 0.58;
          const gradient = context.createRadialGradient(point.x + lx * bodyRadius * 0.34, point.y - ly * bodyRadius * 0.34, bodyRadius * 0.05, point.x, point.y, bodyRadius * 1.12);
          gradient.addColorStop(0, sceneRgba("#fff4dc", lightMode ? 0.62 : 0.36));
          gradient.addColorStop(0.34, tint);
          gradient.addColorStop(0.78, tint);
          gradient.addColorStop(1, "rgba(0,0,0,.92)");
          context.fillStyle = gradient;
          context.beginPath();
          context.arc(point.x, point.y, bodyRadius, 0, Math.PI * 2);
        } else {
          context.fillStyle = sceneRgba("#ffe4a4");
          context.beginPath();
          context.arc(point.x, point.y, radius * 0.72, 0, Math.PI * 2);
        }
        context.shadowColor = tint;
        context.shadowBlur = radius * (node.kind === "sun" ? 1.9 : 0.9);
        context.fill();
        context.shadowBlur = 0;
        context.globalAlpha = 1;
      } else if (node.kind === "galaxy") {
        const ellipseY = radius * 0.53;
        for (let dot = 0; dot < 20; dot += 1) {
          const seed = stableHash(`${node.seed}:${dot}`);
          const ratio = Math.sqrt(unit(seed, 0)) * 0.92;
          const angle = unit(seed, 1) * Math.PI * 2;
          context.globalAlpha = node.opacity * (0.24 + (1 - ratio) * 0.66);
          context.fillStyle = tint;
          context.beginPath();
          context.arc(point.x + Math.cos(angle) * radius * ratio, point.y + Math.sin(angle) * ellipseY * ratio, Math.max(0.7, radius * (0.025 + unit(seed, 2) * 0.055)), 0, Math.PI * 2);
          context.fill();
        }
        context.globalAlpha = 1;
      } else if (node.kind === "armGlow") {
        const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, Math.max(1, radius));
        gradient.addColorStop(0, sceneRgba(node.color, node.opacity * (lightMode ? 0.16 : 0.24)));
        gradient.addColorStop(1, sceneRgba(node.color, 0));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(point.x, point.y, Math.max(1, radius), 0, Math.PI * 2);
        context.fill();
      } else if (node.kind === "blackHole") {
        context.globalAlpha = node.opacity;
        context.shadowColor = sceneRgba("#f2a25a", lightMode ? 0.20 : 0.72);
        context.shadowBlur = Math.max(1, radius * 0.25);
        context.fillStyle = `rgb(${Math.round(horizonRgb[0] * 255)}, ${Math.round(horizonRgb[1] * 255)}, ${Math.round(horizonRgb[2] * 255)})`;
        context.beginPath();
        context.arc(point.x, point.y, radius * 0.34, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
        context.globalAlpha = 1;
      } else if (node.kind === "asteroid") {
        context.beginPath();
        const sides = 8;
        for (let side = 0; side <= sides; side += 1) {
          const angle = side / sides * Math.PI * 2;
          const variation = 0.66 + unit(node.seed, side + 13) * 0.31;
          const x = point.x + Math.cos(angle) * radius * variation;
          const y = point.y + Math.sin(angle) * radius * variation;
          if (side === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath();
        context.fillStyle = sceneRgba("#888d96", node.opacity * 0.9);
        context.fill();
        context.strokeStyle = "rgba(190,198,210,.32)";
        context.lineWidth = 0.7;
        context.stroke();
      } else if (projection.group === "9" && node.kind === "star" && node.id && node.work) {
        context.globalAlpha = node.opacity;
        context.fillStyle = tint;
        context.shadowColor = tint;
        context.shadowBlur = Math.max(2.2, radius * 0.85);
        context.beginPath();
        context.arc(point.x, point.y, Math.max(2.75, radius), 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
        context.globalAlpha = 1;
      } else {
        context.globalAlpha = node.opacity;
        context.fillStyle = tint;
        context.shadowColor = tint;
        context.shadowBlur = radius * 2.4;
        context.beginPath();
        context.arc(point.x, point.y, Math.max(1, radius * 0.37), 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
        context.globalAlpha = 1;
      }
    }
    const lensHole = projection.group === "dropped" ? [...nodes.values()].find((node) => node.kind === "blackHole") : undefined;
    if (lensHole) {
      const center = projected(lensHole, timeline);
      if (center.visible) {
        const arcRadius = Math.max(4, center.size * 0.43);
        context.save();
        context.globalAlpha = lightMode ? 0.55 : 0.88;
        context.strokeStyle = sceneRgba("#ffe1a1");
        context.lineWidth = Math.max(1, arcRadius * 0.055);
        context.shadowColor = sceneRgba("#f6b958", lightMode ? 0.32 : 0.72);
        context.shadowBlur = arcRadius * 0.32;
        context.beginPath();
        context.ellipse(center.x, center.y - arcRadius * 0.43, arcRadius * 1.1, arcRadius * 0.42, 0, Math.PI * 0.12, Math.PI * 0.88);
        context.stroke();
        context.beginPath();
        context.ellipse(center.x, center.y + arcRadius * 0.43, arcRadius * 1.1, arcRadius * 0.42, 0, Math.PI * 1.12, Math.PI * 1.88);
        context.stroke();
        context.restore();
      }
    }
  }
  function emitProjected(time: number) {
    if (!options.onProjected || (!forceProjectionUpdate && time - lastProjectionTime < 16)) return;
    lastProjectionTime = time;
    forceProjectionUpdate = false;
    const objects: UniverseScreenObject[] = [];
    const labelsSuppressed = Boolean(activeScaleTransition) || time < labelsHiddenUntil;
    for (const node of sceneWorkNodes()) {
      const point = projected(node, timeline);
      const inCanvas = point.visible && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
      const deepFieldStableAnchor = projection.group === "7" && node.opacity > 0.08;
      const labelVisible = !labelsSuppressed && node.opacity > 0.08 && (deepFieldStableAnchor || inCanvas);
      let labelOpacity = 1;
      if (projection.group === "8") {
        const zoomRatio = camera.distance / Math.max(0.001, fitDistance);
        const zoomIn = clamp((0.98 - zoomRatio) / 0.23, 0, 1);
        labelOpacity = smooth(zoomIn);
      }
      if (labelsSuppressed) labelOpacity = 0;
      else {
        const postTravelFade = smooth(clamp((time - labelsHiddenUntil) / 200, 0, 1));
        labelOpacity *= transitionLabelsOpacity * postTravelFade;
      }
      objects.push({
        id: node.id!, x: point.x, y: point.y, size: projection.group === "9" ? Math.max(10, point.size) : point.size, depth: point.depth,
        visible: labelVisible,
        selectable: !labelsSuppressed && inCanvas,
        labelOpacity,
      });
    }
    options.onProjected(objects);
  }
  function hasTransition(): boolean {
    if (activeScaleTransition) return true;
    for (const node of nodes.values()) if (node.fadingOut || (node.transitionDuration > 0 && now() - node.startTime < node.transitionDuration)) return true;
    const currentTime = now();
    const labelsFading = labelsHiddenUntil > 0 && currentTime >= labelsHiddenUntil && currentTime < labelsHiddenUntil + 200;
    return labelsFading || (camera.distanceDuration > 0 && currentTime - camera.distanceStarted < camera.distanceDuration);
  }
  function shouldAnimate(): boolean {
    const canTransition = (status === "ready" || status === "fallback") && hasTransition();
    const canAnimateScene = status === "ready" && motion;
    return !disposed && active && inViewport && doc.visibilityState !== "hidden" && (canAnimateScene || canTransition) && quality !== "off";
  }
  function render(time: number) {
    if (disposed) return;
    const animateScene = motion && status === "ready" && quality !== "off";
    if (animateScene && lastMotionTimestamp > 0) timeline += clamp((time - lastMotionTimestamp) / 1000, 0, 0.05);
    lastMotionTimestamp = animateScene ? time : 0;
    setNodePositions(time);
    advanceScaleTransition(time);
    if (!activeScaleTransition) {
      // Keep the conservative path fit during a camera rotation. The current-angle fit
      // is restored once that rotation finishes in setNodePositions().
      if (camera.orientationDuration === 0) fitDistance = fittedDistance(layout, nodes, camera.yaw, camera.pitch);
      const bounds = zoomBounds();
      if (camera.distance > bounds.max) camera.distance = bounds.max;
      camera.targetDistance = clamp(camera.targetDistance, bounds.min, bounds.max);
    }
    resize();
    calculateView();
    if (glResources && quality !== "off") drawWebGL(time);
    else drawFallback(time);
    emitProjected(time);
  }
  function frame(time: number) {
    frameHandle = 0;
    if (disposed || !active || !inViewport || doc.visibilityState === "hidden") return;
    if (lastRenderTime > 0) {
      const elapsed = time - lastRenderTime;
      if (quality === "auto") {
        if (elapsed > 26) slowFrames += 1;
        else slowFrames = Math.max(0, slowFrames - 1);
        if (slowFrames > 42 && effectiveQuality !== "low") {
          effectiveQuality = "low";
          slowFrames = 0;
          fastFramesStarted = 0;
          resize();
        } else if (elapsed < 17 && effectiveQuality === "low") {
          if (!fastFramesStarted) fastFramesStarted = time;
          if (time - fastFramesStarted > 9000) {
            effectiveQuality = "medium";
            slowFrames = 0;
            fastFramesStarted = 0;
            resize();
          }
        } else if (elapsed >= 17) fastFramesStarted = 0;
      }
    }
    lastRenderTime = time;
    render(time);
    if (shouldAnimate()) frameHandle = window.requestAnimationFrame(frame);
  }
  function cancelFrame() {
    if (frameHandle) window.cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  function ensureFrame() {
    if (disposed) return;
    if (shouldAnimate()) {
      if (!frameHandle) frameHandle = window.requestAnimationFrame(frame);
    } else {
      cancelFrame();
      render(now());
    }
  }
  function updateTheme(nextTheme: UniverseTheme) {
    sceneTheme = nextTheme;
    refreshThemeStyle();
    forceProjectionUpdate = true;
    ensureFrame();
  }
  function updateProjection(nextProjection: UniverseProjection, immediate = false) {
    const aspectChanged = nextProjection.group === "9" && projection.group === "9"
      && Math.abs((nextProjection.viewportAspect ?? 3.2) - (projection.viewportAspect ?? 3.2)) > 0.045;
    // Cover palette completion changes appearance, not orbital positions or camera travel.
    const appearanceOnly = !activeScaleTransition && nextProjection.group === projection.group
      && nextProjection.key === projection.key
      && nextProjection.viewportAspect === projection.viewportAspect
      && nextProjection.viewportWidth === projection.viewportWidth
      && nextProjection.viewportHeight === projection.viewportHeight
      && nextProjection.works !== projection.works
      && nextProjection.works.length === projection.works.length
      && nextProjection.works.every((work, index) => {
        const old = projection.works[index];
        return old && work.id === old.id && work.title === old.title
          && work.shortLabel === old.shortLabel && work.rank === old.rank
          && work.rating === old.rating && work.displayOrder === old.displayOrder
          && work.mediaTypeId === old.mediaTypeId && work.coverAssetId === old.coverAssetId;
      });
    if (appearanceOnly) {
      const refreshed = new Map(nextProjection.works.map((work) => [work.id, work]));
      for (const node of nodes.values()) {
        if (!node.work) continue;
        const work = refreshed.get(node.work.id);
        if (!work) continue;
        if (node.color === node.work.palette?.dominant || node.color === node.work.palette?.vibrant) {
          node.color = work.palette?.dominant ?? work.palette?.vibrant ?? node.color;
        }
        node.work = work;
      }
      projection = nextProjection;
      lastProjectionWorks = nextProjection.works;
      forceProjectionUpdate = true;
      ensureFrame();
      return;
    }
    const pending = activeScaleTransition;
    if (pending && nextProjection.group === pending.incomingProjection.group && nextProjection.key === pending.incomingProjection.key) {
      const sameWorkIds = nextProjection.works.length === pending.incomingProjection.works.length
        && nextProjection.works.every((work, index) => work.id === pending.incomingProjection.works[index]?.id);
      if (sameWorkIds) {
        const nextLayout = buildSceneLayout(nextProjection);
        pending.incomingProjection = nextProjection;
        pending.incomingLayout = nextLayout;
        pending.incomingNodes = makeImmediateNodes(nextLayout, now());
        pending.settledTargetFit = fittedDistance(nextLayout, pending.incomingNodes, pending.targetYaw, pending.targetPitch);
        pending.plan.targetFit = pending.wideFov && nextLayout.group !== "7"
          ? pending.settledTargetFit * TRANSITION_FIT_RATIO
          : pending.settledTargetFit;
        if (nextLayout.group === "7" && nextLayout.bounds) {
          pending.targetPan = [(nextLayout.bounds.minX + nextLayout.bounds.maxX) * 0.5, (nextLayout.bounds.minY + nextLayout.bounds.maxY) * 0.5];
        }
        pending.targetBridge = bridgePosition(pending.incomingNodes, nextProjection);
        // Once the handoff has happened, keep the visible scene on the refreshed
        // incoming projection too; otherwise the transition can finish with stale nodes.
        if (pending.switched) {
          nodes = pending.incomingNodes;
          layout = nextLayout;
          lines = nextLayout.lines;
          projection = nextProjection;
          fitDistance = pending.plan.targetFit;
        }
        lastProjectionWorks = nextProjection.works;
        lastProjectionGroup = nextProjection.group;
        lastProjectionKey = nextProjection.key;
        lastProjectionTime = 0;
        forceProjectionUpdate = true;
        ensureFrame();
        return;
      }
    }
    const onlyMaskChanged = !aspectChanged && nextProjection.group === lastProjectionGroup && nextProjection.works === lastProjectionWorks && nextProjection.key === lastProjectionKey;
    lastProjectionTime = 0;
    forceProjectionUpdate = true;
    if (!onlyMaskChanged) installLayout(nextProjection, immediate || aspectChanged);
    else { projection = nextProjection; ensureFrame(); }
  }
  function resizeForStage() {
    resize();
    if (projection.group === "9") {
      const aspect = width / Math.max(1, height);
      if (Math.abs(aspect - (projection.viewportAspect ?? 3.2)) > 0.045) {
        updateProjection({ ...projection, viewportAspect: aspect }, true);
        return;
      }
    }
    ensureFrame();
  }
  function updateQuality(nextQuality: UniverseQuality) {
    quality = nextQuality;
    effectiveQuality = nextQuality === "high" ? "high" : nextQuality === "low" ? "low" : "medium";
    if (nextQuality === "off") {
      if (!glResources) makeFallbackOverlay();
      setStatus("fallback");
      lastMotionTimestamp = 0;
      cancelFrame();
      render(now());
      return;
    }
    if (!glResources && canvasHasWebGL) initializeGL();
    if (glResources) {
      removeFallbackOverlay();
      setStatus("ready");
    } else {
      // A canvas context cannot change from 2D to WebGL; the static fallback remains available.
      makeFallbackOverlay();
      setStatus("fallback");
    }
    resize();
    ensureFrame();
  }
  function updateMotion(enabled: boolean) {
    motion = enabled;
    lastMotionTimestamp = 0;
    ensureFrame();
  }
  function setActive(nextActive: boolean) {
    active = nextActive;
    if (!active) { lastMotionTimestamp = 0; cancelFrame(); }
    else ensureFrame();
  }
  function rotateBy(deltaX: number, deltaY: number) {
    if (activeScaleTransition) return;
    if (projection.group === "7") {
      panBy(deltaX, deltaY);
      return;
    }
    userAdjusted = true;
    camera.yaw = ((camera.yaw + deltaX * 0.006 + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    camera.pitch = clamp(camera.pitch + deltaY * 0.006, -1.3, 1.3);
    camera.yawFrom = camera.yawTarget = camera.yaw;
    camera.pitchFrom = camera.pitchTarget = camera.pitch;
    camera.orientationDuration = 0;
    fitDistance = fittedDistance(layout, nodes, camera.yaw, camera.pitch);
    const bounds = zoomBounds();
    camera.distance = Math.min(camera.distance, bounds.max);
    camera.targetDistance = Math.min(camera.targetDistance, bounds.max);
    scheduleViewStateChange();
    ensureFrame();
  }
  function panBy(deltaX: number, deltaY: number) {
    if (activeScaleTransition || projection.group !== "7") return;
    userAdjusted = true;
    const worldPerPixel = 2 * camera.distance / Math.max(1, height);
    panX -= deltaX * worldPerPixel;
    panY += deltaY * worldPerPixel;
    clampDeepPan();
    scheduleViewStateChange();
    forceProjectionUpdate = true;
    ensureFrame();
  }
  function restoreViewState(state: UniverseViewState) {
    if (state.group !== projection.group) return;
    userAdjusted = state.userAdjusted === true;
    const deepField = projection.group === "7";
    const yaw = deepField ? 0 : userAdjusted && Number.isFinite(state.yaw) ? state.yaw : layoutYaw(layout);
    camera.yaw = ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    camera.pitch = deepField ? 0 : clamp(userAdjusted && Number.isFinite(state.pitch) ? state.pitch : layoutPitch(layout), -1.3, 1.3);
    camera.yawFrom = camera.yawTarget = camera.yaw;
    camera.pitchFrom = camera.pitchTarget = camera.pitch;
    camera.orientationDuration = 0;
    fitDistance = fittedDistance(layout, nodes, camera.yaw, camera.pitch);
    const bounds = zoomBounds();
    camera.distance = clamp(userAdjusted && Number.isFinite(state.distance) ? state.distance : fitDistance, bounds.min, bounds.max);
    if (deepField) {
      const map = deepBounds(layout, nodes);
      panX = userAdjusted && Number.isFinite(state.panX) ? state.panX! : (map.minX + map.maxX) * 0.5;
      panY = userAdjusted && Number.isFinite(state.panY) ? state.panY! : (map.minY + map.maxY) * 0.5;
      clampDeepPan();
    }
    camera.distanceFrom = camera.distance;
    camera.targetDistance = camera.distance;
    camera.distanceDuration = 0;
    forceProjectionUpdate = true;
    ensureFrame();
  }
  function reset() {
    userAdjusted = false;
    const deepField = projection.group === "7";
    const targetYaw = deepField ? 0 : layoutYaw(layout);
    const targetPitch = deepField ? 0 : layoutPitch(layout);
    const duration = !deepField && motion && status === "ready" && quality !== "off" ? 420 : 0;
    if (deepField) {
      const bounds = deepBounds(layout, nodes);
      panX = (bounds.minX + bounds.maxX) * 0.5;
      panY = (bounds.minY + bounds.maxY) * 0.5;
    }
    camera.yawFrom = camera.yaw;
    camera.yawTarget = targetYaw;
    camera.pitchFrom = camera.pitch;
    camera.pitchTarget = targetPitch;
    camera.orientationStarted = now();
    camera.orientationDuration = duration;
    if (!duration) {
      camera.yaw = targetYaw;
      camera.pitch = targetPitch;
    }
    fitDistance = duration
      ? fitAcrossOrientation(layout, nodes, camera.yaw, camera.pitch, targetYaw, targetPitch)
      : fittedDistance(layout, nodes, targetYaw, targetPitch);
    camera.distanceFrom = camera.distance;
    camera.targetDistance = fitDistance;
    camera.distanceStarted = now();
    camera.distanceDuration = duration;
    scheduleViewStateChange(camera.distanceDuration + 40);
    ensureFrame();
  }
  function pickAt(x: number, y: number): string | null {
    let closest: { id: string; distance: number; depth: number } | null = null;
    if (now() < suppressClickUntil || activeScaleTransition) return null;
    calculateView();
    for (const node of sceneWorkNodes()) {
      const point = projected(node, timeline);
      if (!point.visible) continue;
      const dx = x - point.x;
      const dy = y - point.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = Math.max(8, point.size * 0.72);
      if (distance <= hitRadius && (!closest || distance < closest.distance || (distance === closest.distance && point.depth < closest.depth))) closest = { id: node.id!, distance, depth: point.depth };
    }
    return closest?.id ?? null;
  }
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    isDragging = true;
    dragPointerId = event.pointerId;
    pointerX = event.clientX;
    pointerY = event.clientY;
    dragDistance = 0;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Older WebViews may not support capture. */ }
  }
  function pointerMove(event: PointerEvent) {
    if (!isDragging || event.pointerId !== dragPointerId) return;
    const dx = event.clientX - pointerX;
    const dy = event.clientY - pointerY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    rotateBy(dx, dy);
  }
  function pointerUp(event: PointerEvent) {
    if (event.pointerId !== dragPointerId) return;
    if (dragDistance > 8) suppressClickUntil = now() + 120;
    isDragging = false;
    dragPointerId = null;
  }
  function wheel(event: WheelEvent) {
    event.preventDefault();
    if (activeScaleTransition) return;
    const factor = Math.exp(clamp(event.deltaY, -240, 240) * 0.0011);
    const bounds = zoomBounds();
    const oldDistance = camera.distance;
    camera.distance = clamp(camera.distance * factor, bounds.min, bounds.max);
    if (camera.distance !== oldDistance) userAdjusted = true;
    if (projection.group === "7" && camera.distance !== oldDistance) {
      const rect = canvas.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / Math.max(1, width) * 2 - 1;
      const ny = 1 - (event.clientY - rect.top) / Math.max(1, height) * 2;
      const anchorX = panX + nx * oldDistance * width / Math.max(1, height);
      const anchorY = panY + ny * oldDistance;
      panX = anchorX - nx * camera.distance * width / Math.max(1, height);
      panY = anchorY - ny * camera.distance;
      clampDeepPan();
    }
    camera.distanceFrom = camera.distance;
    camera.targetDistance = camera.distance;
    camera.distanceDuration = 0;
    scheduleViewStateChange();
    ensureFrame();
  }
  function contextLost(event: Event) {
    event.preventDefault();
    glResources = null;
    // Keep the original canvas as the interaction surface beneath the 2D fallback overlay.
    canvas.style.visibility = "visible";
    lastMotionTimestamp = 0;
    forceProjectionUpdate = true;
    makeFallbackOverlay();
    setStatus("fallback");
    ensureFrame();
  }
  function contextRestored() {
    if (quality === "off") return;
    if (initializeGL()) {
      resize();
      ensureFrame();
    }
  }
  function visibilityChange() {
    if (doc.visibilityState === "hidden") { lastMotionTimestamp = 0; cancelFrame(); }
    else { forceProjectionUpdate = true; ensureFrame(); }
  }
  function initializeFallback() {
    if (canvasHasWebGL) makeFallbackOverlay();
    else {
      fallbackCanvas = canvas;
      fallbackContext = canvas.getContext("2d", { alpha: true });
    }
    setStatus("fallback");
  }

  if (initializeGL()) {
    canvas.addEventListener("webglcontextlost", contextLost, false);
    canvas.addEventListener("webglcontextrestored", contextRestored, false);
  } else {
    initializeFallback();
    if (quality === "off") setStatus("fallback");
  }
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("wheel", wheel, { passive: false });
  doc.addEventListener("visibilitychange", visibilityChange);
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeForStage);
  resizeObserver?.observe(canvas);
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((entries) => {
      inViewport = entries[0]?.isIntersecting ?? true;
      if (!inViewport) { lastMotionTimestamp = 0; cancelFrame(); }
      else { forceProjectionUpdate = true; ensureFrame(); }
    });
    observer.observe(canvas);
  }
  resize();
  const initialTime = now();
  nodes = makeImmediateNodes(layout, initialTime);
  fitDistance = fittedDistance(layout, nodes, camera.yaw, camera.pitch);
  const bounds = zoomBounds();
  camera.distance = options.initialViewState?.group === projection.group && userAdjusted
    ? clamp(camera.distance, bounds.min, bounds.max)
    : fitDistance;
  if (projection.group === "7") {
    camera.yaw = camera.pitch = 0;
    if (!userAdjusted || options.initialViewState?.group !== projection.group || (!Number.isFinite(options.initialViewState?.panX) && !Number.isFinite(options.initialViewState?.panY))) {
      const map = deepBounds(layout, nodes);
      panX = (map.minX + map.maxX) * 0.5;
      panY = (map.minY + map.maxY) * 0.5;
    }
    clampDeepPan();
  }
  camera.distanceFrom = camera.distance;
  camera.targetDistance = camera.distance;
  resize();
  calculateView();
  render(initialTime);
  if (shouldAnimate()) frameHandle = window.requestAnimationFrame(frame);

  return {
    updateProjection,
    updateTheme,
    updateSelection(id) { selectedId = id; forceProjectionUpdate = true; ensureFrame(); },
    updateQuality,
    updateMotion,
    setActive,
    getViewState,
    restoreViewState,
    rotateBy,
    panBy,
    pickAt,
    reset,
    dispose() {
      if (disposed) return;
      if (viewStateTimer !== null) flushViewState();
      disposed = true;
      cancelFrame();
      observer?.disconnect();
      resizeObserver?.disconnect();
      doc.removeEventListener("visibilitychange", visibilityChange);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      if (glResources) {
        const { gl, billboard, line, billboardBuffer, lineBuffer } = glResources;
        gl.deleteProgram(billboard.program);
        gl.deleteProgram(line.program);
        gl.deleteBuffer(billboardBuffer);
        gl.deleteBuffer(lineBuffer);
        glResources = null;
      }
      removeFallbackOverlay();
      nodes.clear();
    },
  };
}
