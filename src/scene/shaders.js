/** GLSL for the void octopus. Kept in one place so the look can be tuned fast. */

export const mantleVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPulse;
  uniform float uEnergy;

  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;

  void main() {
    vec3 p = position;

    // breathing: the mantle slowly inflates, and a click makes it swell once
    float breath = sin(uTime * 1.15) * 0.012
                 + sin(uTime * 0.43 + 1.7) * 0.008
                 + uPulse * 0.03
                 + uEnergy * 0.006;
    p *= 1.0 + breath;

    // a lazy ripple travelling up the body
    p.x += sin(position.y * 5.0 + uTime * 0.8) * 0.008;
    p.z += cos(position.y * 4.0 + uTime * 0.62) * 0.008;

    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorldPos = world.xyz;
    vLocalPos = p;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const mantleFragment = /* glsl */ `
  uniform float uTime;
  uniform float uGlow;
  uniform float uPulse;
  uniform float uEnergy;
  uniform vec3 uRimA;
  uniform vec3 uRimB;

  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);

    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.8);

    // deep body, slightly lighter toward the crown
    float crown = smoothstep(-0.5, 1.6, vLocalPos.y);
    vec3 base = mix(vec3(0.0015, 0.0025, 0.009), vec3(0.006, 0.016, 0.05), crown);

    // iridescent rim: cyan at the crown, violet toward the skirt
    float irid = 0.5 + 0.5 * sin(fres * 5.0 + vLocalPos.y * 2.6 + uTime * 0.35);
    vec3 rim = mix(uRimA, uRimB, irid);

    // fake key light, upper right
    vec3 L = normalize(vec3(0.55, 0.8, 0.75));
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0);

    // bioluminescent speckles, cells fixed to the body
    vec3 cell = floor(vLocalPos * 15.0);
    float h = hash31(cell);
    float speck = smoothstep(0.972, 1.0, h)
                * (0.45 + 0.55 * sin(uTime * 1.9 + h * 42.0));

    // faint aurora band around the skirt where the arms begin
    float skirt = smoothstep(0.5, 0.15, vLocalPos.y) * smoothstep(-0.35, 0.1, vLocalPos.y);
    float aurora = skirt * (0.5 + 0.5 * sin(uTime * 0.7 + vLocalPos.x * 5.0));

    vec3 col = base;
    col += rim * fres * (0.62 + uGlow * 0.28);
    col += vec3(0.3, 0.8, 1.0) * speck * (0.3 + uEnergy * 0.4);
    col += vec3(1.0) * spec * (0.08 + uGlow * 0.08);
    col += vec3(0.03, 0.22, 0.38) * aurora * 0.32;
    col *= 0.85 + uPulse * 0.9;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const tentacleVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const tentacleFragment = /* glsl */ `
  uniform float uTime;
  uniform float uGlow;
  uniform float uPulse;
  uniform float uEnergy;
  uniform vec3 uBase;
  uniform vec3 uTip;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    float t = clamp(vUv.y, 0.0, 1.0);
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);

    float fres = pow(1.0 - abs(dot(N, V)), 1.6);

    vec3 col = mix(uBase, uTip, smoothstep(0.0, 1.0, t));

    // one soft wave travelling from the body to the tip
    float wave = sin(t * 17.0 - uTime * (1.5 + uGlow * 1.1) + sin(vUv.x * 6.28318) * 0.45);
    float band = smoothstep(0.62, 1.0, wave) * smoothstep(0.04, 0.3, t);
    float sheen = smoothstep(0.15, 0.85, t) * (0.5 + 0.5 * sin(t * 7.0 - uTime * 1.1));

    vec3 cyan = vec3(0.12, 0.9, 1.0);
    vec3 violet = vec3(0.72, 0.3, 1.0);

    col += mix(cyan, violet, smoothstep(0.25, 0.9, t)) * fres * (1.05 + uGlow * 0.4);
    col += cyan * band * (0.32 + uGlow * 0.28);
    col += vec3(0.55, 0.9, 1.0) * sheen * (0.05 + uEnergy * 0.03);

    // glowing tip
    float tip = smoothstep(0.76, 1.0, t);
    col += mix(cyan, violet, t) * tip * (0.95 + uPulse * 0.55);

    col *= 0.92 + uEnergy * 0.28 + uPulse * 0.9;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const backgroundVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const backgroundFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;

  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 p = (vUv - 0.5) * vec2(2.2, 1.4);
    float t = uTime * 0.008;

    float n1 = fbm(p * 2.6 + vec2(t, -t * 0.6));
    float n2 = fbm(p * 4.4 + vec2(-t * 0.8, t * 0.4) + n1);

    float cloud = smoothstep(0.28, 0.82, n1 * 0.65 + n2 * 0.55);
    float wisp = smoothstep(0.55, 1.0, n2) * (1.0 - smoothstep(0.0, 0.55, length(p - vec2(0.1, -0.05))));

    vec3 col = mix(uColorA, uColorB, cloud);
    col = mix(col, uColorC, wisp * 0.55);

    // deep falloff so the centre stays darker than the edges
    float vign = smoothstep(1.35, 0.12, length(p * vec2(0.9, 1.0)));
    col *= 0.55 + 0.45 * vign;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const moteVertex = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;

  uniform float uTime;
  uniform float uGlow;
  uniform float uPixelRatio;

  varying float vSeed;

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    p.x += sin(uTime * 0.16 + aSeed * 20.0) * 0.28;
    p.y += cos(uTime * 0.12 + aSeed * 17.0) * 0.22;
    p.z += sin(uTime * 0.1 + aSeed * 13.0) * 0.18;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPixelRatio * (120.0 / max(-mv.z, 0.001)) * (0.7 + uGlow * 0.55);
    gl_Position = projectionMatrix * mv;
  }
`;

export const moteFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vSeed;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    a *= a;

    vec3 cyan = vec3(0.35, 0.9, 1.0);
    vec3 violet = vec3(0.7, 0.35, 1.0);
    vec3 col = mix(cyan, violet, fract(vSeed * 7.31));

    gl_FragColor = vec4(col, a * uOpacity);
  }
`;

export const eyeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const eyeFragment = /* glsl */ `
  uniform float uTime;
  uniform vec2 uGaze;
  uniform float uPupil;
  uniform float uBlink;
  uniform float uGlow;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    vec2 p = vUv - 0.5;
    vec2 q = p - uGaze * vec2(0.11, 0.095);
    float r = length(q * vec2(1.0, 1.08));

    vec3 iris = mix(vec3(0.78, 1.0, 1.0), vec3(0.08, 0.5, 0.95), smoothstep(0.02, 0.2, r));
    iris = mix(iris, vec3(0.015, 0.06, 0.2), smoothstep(0.2, 0.35, r));

    float angle = atan(q.y, q.x);
    float streaks = 0.5 + 0.5 * sin(angle * 28.0 + r * 32.0 + uTime * 0.55);
    iris *= 0.82 + 0.18 * streaks;
    iris += vec3(0.05, 0.3, 0.5) * pow(1.0 - smoothstep(0.04, 0.17, r), 2.0) * 0.5;

    float pupilWidth = 0.02 + 0.012 * uPupil;
    float pupil = 1.0 - smoothstep(pupilWidth, pupilWidth + 0.013, abs(q.x));
    pupil *= 1.0 - smoothstep(0.19 * uPupil, 0.24 * uPupil, abs(q.y));

    float irisMask = 1.0 - smoothstep(0.33, 0.39, r);
    float limbal = smoothstep(0.33, 0.39, r) * (1.0 - smoothstep(0.39, 0.45, r));

    vec3 col = vec3(0.001, 0.002, 0.006);
    col = mix(col, iris, irisMask);
    col = mix(col, vec3(0.0), pupil * irisMask);
    col = mix(col, vec3(0.0), limbal * 0.82);

    float h1 = 1.0 - smoothstep(0.016, 0.042, length(p - vec2(-0.105, -0.115)));
    col += vec3(1.0, 1.0, 1.0) * h1 * 1.6;
    float h2 = 1.0 - smoothstep(0.007, 0.024, length(p - vec2(0.078, 0.095)));
    col += vec3(0.7, 0.95, 1.0) * h2 * 0.5;

    // top and bottom lids close toward the centre; uBlink 0 keeps the eye open
    float top = smoothstep(0.84 - uBlink * 0.34, 0.92 - uBlink * 0.34, vUv.y);
    float bottom = smoothstep(0.16 + uBlink * 0.34, 0.08 + uBlink * 0.34, vUv.y);
    float lid = clamp(top + bottom, 0.0, 1.0);
    vec3 lidCol = vec3(0.007, 0.013, 0.028);
    col = mix(col, lidCol, lid);

    // a soft crease where the lid meets the eye
    float creaseY = 0.84 - uBlink * 0.34;
    float crease = 1.0 - smoothstep(0.0, 0.025, abs(vUv.y - creaseY));
    col += vec3(0.02, 0.05, 0.08) * crease * (0.3 + 0.7 * uBlink);

    col *= 0.92 + uGlow * 0.18;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const webVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const webFragment = /* glsl */ `
  uniform float uTime;
  uniform float uGlow;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    float edge = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.78, 1.0, vUv.y));
    float veins = 0.5 + 0.5 * sin(vUv.x * 18.0 + vUv.y * 10.0 + uTime * 0.7);
    vec3 col = mix(vec3(0.04, 0.16, 0.3), vec3(0.24, 0.1, 0.4), vUv.x);
    col += vec3(0.05, 0.25, 0.35) * veins * 0.18;
    gl_FragColor = vec4(col * (0.7 + uGlow * 0.4), edge * 0.22 * uOpacity);
  }
`;
