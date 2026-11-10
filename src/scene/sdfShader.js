/** Ray-marched void octopus: one continuous SDF, no assembled tubes. */

export const sdfVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const ARM_POINT_RADIUS = [0.2, 0.175, 0.15, 0.12, 0.09, 0.06, 0.035, 0.02]

/**
 * Widening factor for the virtual lens.
 *
 * The body is wider than the render target at its widest pose: once the tip
 * spring overshoots (which is the whole point of an under-damped arm), the arm
 * points reach a projected |ndc| of ~0.96 with a 1.25 lens — only 12 px of
 * canvas headroom on a 625 px box, and that is before the bloom halo. 0.9.30
 * opens it to 1.30 (box 650 px) for ~25 px of headroom, and the CSS base box
 * grows by the same factor so the creature's APPARENT size is unchanged: the
 * extra pixels exist only to hold the arms.
 */
export const FOV_SCALE = 1.3

function armCode() {
  let out = ''
  // One conservative bounding sphere per arm, refreshed on the CPU every frame
  // (centroid of the eight control points, radius to the farthest one plus its
  // tube radius), inflated by k/4 (the largest smin bulge) plus a margin. Two
  // exact uses:
  //   1. every bound is far -> the min bound is a valid LOWER bound, so a
  //      sample far from the creature costs nine distance tests instead of 56
  //      capsule evaluations;
  //   2. an arm whose bound is farther than the current exact distance cannot
  //      lower it, so its capsules are skipped.
  // A lower bound that is too small only costs steps; a bound that is too large
  // makes the march overshoot and eats geometry — that is the 0.9.13 failure.
  //
  // Written as loops rather than eight unrolled copies on purpose: the unrolled
  // form made ANGLE/D3D's shader compiler take minutes on first use, freezing
  // the whole page while the GPU process translated it.
  out += `    float boundMin = bBody;\n`
  out += `    for (int k = 0; k < 8; k++) {\n`
  out += `      boundMin = min(boundMin, length(q - uArmBound[k].xyz) - uArmBound[k].w);\n`
  out += `    }\n`
  out += `    if (uCull > 0.5 && boundMin > ${CULL_DIST.toFixed(2)}) return vec2(boundMin, 0.0);\n\n`
  out += `    vec2 res = vec2(bodyDistance(q), 1.0);\n`
  out += `    for (int k = 0; k < 8; k++) {\n`
  out += `      float boundD = length(q - uArmBound[k].xyz) - uArmBound[k].w;\n`
  out += `      if (uCull > 0.5 && boundD >= res.x + ${BLEND_PAD.toFixed(2)}) continue;\n`
  for (let i = 0; i < 7; i++) {
    // The root segment keeps the wide blend so the arm grows out of the body
    // with no seam. Segments past the root use a much tighter blend: at 0.08
    // the eight arms fused into one continuous sheet whenever swimming drew
    // them close together, which read as a skirt rather than eight arms.
    const blend = i === 0 ? '0.080' : '0.045'
    out += `      res = opSmooth(res, vec2(sdCapsule(q, uArmPts[k * 8 + ${i}], uArmPts[k * 8 + ${i + 1}], uRadii[${i}], uRadii[${i + 1}]), 2.0), ${blend});\n`
  }
  out += `    }\n`
  return out
}

const CULL_DIST = 0.3
// A skip is only taken when the bound is 0.05 beyond the current exact
// distance, well past the largest smooth-union bulge (k/2 = 0.04), so the
// blend that stitches arm to body is never lost.
const BLEND_PAD = 0.05

function armInfoCode() {
  let out = ''
  out += `    for (int k = 0; k < 8; k++) {\n`
  out += `      float boundD = length(p - uArmBound[k].xyz) - uArmBound[k].w;\n`
  out += `      if (uCull > 0.5 && boundD >= bestD) continue;\n`
  for (let i = 0; i < 7; i++) {
    out += `      {\n`
    out += `        vec3 a = uArmPts[k * 8 + ${i}];\n`
    out += `        vec3 pb = uArmPts[k * 8 + ${i + 1}];\n`
    out += `        vec3 ba = pb - a;\n`
    out += `        vec3 pa = p - a;\n`
    out += `        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);\n`
    out += `        vec3 closest = a + ba * h;\n`
    out += `        vec3 diff = p - closest;\n`
    out += `        float d = length(diff);\n`
    out += `        if (d < bestD) {\n`
    out += `          bestD = d;\n`
    out += `          bestT = (${i}.0 + h) / 7.0;\n`
    out += `          bestRadial = diff;\n`
    out += `          bestTangent = normalize(ba);\n`
    out += `        }\n`
    out += `      }\n`
  }
  out += `    }\n`
  return out
}

export { ARM_POINT_RADIUS }

export const sdfFragment = /* glsl */ `
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uGlow;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uBlink;
  uniform float uPupil;
  uniform vec2 uGaze;
  uniform float uYaw;
  uniform float uPitch;
  uniform float uRoll;
  uniform vec3 uOffset;
  uniform vec2 uSwim;
  uniform float uSwimAmount;
  uniform vec3 uArmPts[64];
  uniform float uRadii[8];
  uniform mat3 uInvRot;
  // Radius of the whole-creature bounding sphere used to skip empty rays.
  // It used to be a hardcoded 2.1, but the arm points reach 2.17 world units
  // from the focus once the tip spring overshoots (0.9.30): anything outside the
  // sphere is never marched, so those tip pixels vanished — a hard cut that only
  // showed up "sometimes, when the arms splayed". The CPU now derives this from
  // the control points that were actually uploaded, so it cannot fall behind.
  uniform float uCullR;
  uniform vec4 uArmBound[8];
  uniform vec4 uBodyBound;
  uniform float uCull;
  // Palette slots. Every previously hard-coded hue now comes from the host so
  // one shader serves all presets.
  uniform vec3 uColDeep;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uIrisA;
  uniform vec3 uIrisB;

  varying vec2 vUv;

  const float PI = 3.14159265;
  const int MAX_STEPS = 30;

  mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }
  mat3 rotX(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }
  mat3 rotZ(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
  }

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }

  float sdEllipsoid(vec3 p, vec3 r) {
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
  }

  float sdCapsule(vec3 p, vec3 a, vec3 b, float ra, float rb) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - mix(ra, rb, h);
  }

  float sminf(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  vec2 opSmooth(vec2 a, vec2 b, float k) {
    float h = clamp(0.5 + 0.5 * (b.x - a.x) / k, 0.0, 1.0);
    float d = mix(b.x, a.x, h) - k * h * (1.0 - h);
    // Material 0 means "this is a bounding volume, not a surface". The main
    // loop only accepts hits with material > 0, so an early-out distance can
    // never be mistaken for geometry (the 0.9.13 phantom-face failure).
    return vec2(d, a.x < b.x ? a.y : b.y);
  }

  float bodyDistance(vec3 q) {
    float breath = 1.0 + 0.012 * sin(uTime * 1.1) - 0.03 * uPulse;

    // two-lobe head: a rounded mantle sac above, a narrower eye-bearing head below
    float mantle = sdEllipsoid(q - vec3(0.0, 0.98, 0.0), vec3(0.52, 0.6, 0.46) * breath);
    float head = sdEllipsoid(q - vec3(0.0, 0.5, 0.06), vec3(0.56, 0.4, 0.5) * breath);
    float body = sminf(mantle, head, 0.16);

    // a raised brow/eye socket on each side of the head
    float socket1 = sdEllipsoid(q - vec3(-0.43, 0.52, 0.42), vec3(0.16, 0.18, 0.16));
    float socket2 = sdEllipsoid(q - vec3(0.43, 0.52, 0.42), vec3(0.16, 0.18, 0.16));
    body = sminf(body, min(socket1, socket2), 0.05);

    // a short scalloped web where the head meets the arm crown
    float webT = clamp(-q.y / 0.3, 0.0, 1.0);
    // This skirt only reads as part of the crown while the arms are splayed to
    // cover it. Swimming draws the arms inward, which used to leave the ring
    // standing exposed on its own — so it contracts together with them.
    float webR = mix(0.5, 0.78, webT) * (1.0 - uSwimAmount * 0.42);
    webR += sin(atan(q.z, q.x) * 8.0 + uTime * 0.25) * 0.02;
    float web = abs(length(q.xz) - webR) - 0.016;
    web = max(web, max(q.y - 0.02, -0.3 - q.y));
    body = sminf(body, web, 0.08);

    // funnel / siphon: a short tube with a subtracted opening
    float siphon = sdCapsule(q, vec3(0.0, 0.36, 0.32), vec3(0.0, 0.3, 0.64), 0.06, 0.09);
    float siphonHole = sdCapsule(q, vec3(0.0, 0.35, 0.36), vec3(0.0, 0.31, 0.69), 0.025, 0.055);
    siphon = max(siphon, -siphonHole);
    body = sminf(body, siphon, 0.05);
    return body;
  }

  vec2 map(vec3 p) {
    vec3 q = uInvRot * (p - uOffset);

    float bBody = length(q - uBodyBound.xyz) - uBodyBound.w;
${armCode()}
    vec3 e1 = q - vec3(-0.43, 0.52, 0.42);
    vec3 e2 = q - vec3(0.43, 0.52, 0.42);
    float eye = min(length(e1) - 0.2, length(e2) - 0.2);
    res = eye < res.x ? vec2(eye, 4.0) : res;

    return res;
  }

  vec3 calcNormal(vec3 p) {
    const vec2 e = vec2(0.0025, -0.0025);
    return normalize(
      e.xyy * map(p + e.xyy).x +
      e.yyx * map(p + e.yyx).x +
      e.yxy * map(p + e.yxy).x +
      e.xxx * map(p + e.xxx).x
    );
  }

  vec3 eyeColor(vec3 q) {
    vec3 c1 = vec3(-0.43, 0.52, 0.42);
    vec3 c2 = vec3(0.43, 0.52, 0.42);
    vec3 center = length(q - c1) < length(q - c2) ? c1 : c2;
    vec3 e = (q - center) / 0.2;
    float side = center.x < 0.0 ? -1.0 : 1.0;
    vec3 eyeN = normalize(vec3(side * 0.42, 0.0, 0.91));
    vec3 eyeT = normalize(cross(vec3(0.0, 1.0, 0.0), eyeN));
    vec3 eyeB = normalize(cross(eyeN, eyeT));
    vec2 hp = vec2(dot(e, eyeT), dot(e, eyeB));
    vec2 p = hp - uGaze * vec2(0.03, 0.03);

    float r = length(p * vec2(1.0, 1.08));
    vec3 iris = mix(uIrisA, uIrisB, smoothstep(0.03, 0.28, r));
    iris = mix(iris, uIrisB * 0.12, smoothstep(0.38, 0.47, r));
    float angle = atan(p.y, p.x);
    iris *= 0.82 + 0.18 * (0.5 + 0.5 * sin(angle * 26.0 + r * 34.0 + uTime * 0.5));
    iris += uIrisA * 0.35 * pow(1.0 - smoothstep(0.04, 0.18, r), 2.0);

    float pupilH = 0.012 + 0.005 * uPupil;
    float pupil = 1.0 - smoothstep(pupilH, pupilH + 0.012, abs(p.y));
    pupil *= 1.0 - smoothstep(0.15 * uPupil, 0.19 * uPupil, abs(p.x));

    float irisMask = 1.0 - smoothstep(0.43, 0.49, r);
    float limbal = smoothstep(0.43, 0.49, r) * (1.0 - smoothstep(0.49, 0.55, r));
    vec3 col = vec3(0.001, 0.002, 0.006);
    col = mix(col, iris, irisMask);
    col = mix(col, vec3(0.0), pupil * irisMask);
    col = mix(col, vec3(0.0), limbal * 0.8);

    float h1 = 1.0 - smoothstep(0.015, 0.04, length(hp - vec2(-0.1, -0.1)));
    col += vec3(1.0) * h1 * 1.3;
    float h2 = 1.0 - smoothstep(0.007, 0.025, length(hp - vec2(0.07, 0.08)));
    col += vec3(0.6, 0.95, 1.0) * h2 * 0.35;

    float top = smoothstep(0.82 - uBlink * 0.34, 0.9 - uBlink * 0.34, e.y);
    float bottom = smoothstep(0.16 + uBlink * 0.34, 0.08 + uBlink * 0.34, e.y);
    float lid = clamp(top + bottom, 0.0, 1.0);
    col = mix(col, vec3(0.006, 0.012, 0.026), lid);
    return col * (0.9 + uGlow * 0.15);
  }

  vec4 armInfo(vec3 p) {
    float bestD = 1e9;
    float bestT = 0.0;
    vec3 bestRadial = vec3(0.0);
    vec3 bestTangent = vec3(0.0, 1.0, 0.0);
${armInfoCode()}
    vec3 side = normalize(cross(bestTangent, vec3(0.0, 1.0, 0.0)) + vec3(0.0001, 0.0, 0.0));
    vec3 up2 = normalize(cross(bestTangent, side));
    vec3 radial = normalize(bestRadial + vec3(0.0001, 0.0, 0.0));
    float angle = atan(dot(radial, up2), dot(radial, side));
    float under = dot(radial, vec3(0.0, -1.0, 0.0));
    return vec4(bestT, angle, under, bestD);
  }

  vec3 shade(vec3 p, vec3 n, vec3 rd, float mat) {
    vec3 v = normalize(-rd);
    float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.2);
    float key = clamp(dot(n, normalize(vec3(0.45, 0.9, 0.65))), 0.0, 1.0);
    float topLight = clamp(dot(n, normalize(vec3(0.1, 1.0, 0.2))), 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 1.4);

    float mott = noise3(p * 3.2 + vec3(0.0, uTime * 0.02, 0.0));
    float starHash = hash13(floor(p * 20.0));
    float star = smoothstep(0.988, 1.0, starHash);
    star *= 0.4 + 0.6 * sin(uTime * 1.7 + starHash * 30.0);

    vec3 cyan = uColA;
    vec3 violet = uColB;
    vec3 deep = uColDeep;

    if (mat > 3.5) return eyeColor(p) * 2.3;

    vec3 base = mix(deep, mix(deep, cyan, 0.22), smoothstep(-0.9, 1.1, p.y));
    base += mix(vec3(0.0, 0.025, 0.06), vec3(0.06, 0.012, 0.1), mott) * 0.55;

    // chromatophore patches and papillae, like a real octopus skin
    float chroma = noise3(p * 1.7 + vec3(uTime * 0.008, 0.0, 0.0));
    base += mix(vec3(0.0, 0.03, 0.055), vec3(0.12, 0.045, 0.02), smoothstep(0.56, 0.82, chroma)) * 0.55;
    float papillae = smoothstep(0.72, 0.96, noise3(p * 11.0 + vec3(0.0, uTime * 0.01, 0.0)));
    base += vec3(0.025, 0.05, 0.07) * papillae;
    vec3 starCol = mix(cyan, violet, 0.5 + 0.5 * sin(starHash * 30.0));
    base += starCol * star * 1.2;

    vec3 rimCol = mix(cyan, violet, 0.5 + 0.5 * sin(fres * 4.0 + p.y * 2.0 + uTime * 0.3));
    vec3 col = base;
    col += rimCol * fres * (0.55 + uGlow * 0.3);
    col += vec3(0.12, 0.38, 0.65) * key * 0.22;
    col += vec3(0.18, 0.3, 0.45) * topLight * 0.12;
    col += vec3(0.02, 0.1, 0.18) * rim * 0.3;
    float wet = pow(max(dot(reflect(-normalize(vec3(0.5, 0.8, 0.7)), n), v), 0.0), 60.0);
    col += vec3(0.25, 0.45, 0.6) * wet * 0.25;

    if (mat > 1.5 && mat < 2.5) {
      vec4 info = armInfo(p);
      float t = info.x;
      float angle = info.y;
      float under = info.z;
      // Suckers. The old stripe ran at 72 cycles per arm — under two pixels per
      // stripe at display size, so it aliased into grain instead of reading as
      // suckers. 26 cycles keeps every stripe ≥ 5 px wide.
      float dots = smoothstep(0.72, 0.98, sin(t * 26.0 + sin(angle * 2.0) * 1.2));
      float underMask = smoothstep(-0.05, 0.55, under);
      col += mix(cyan, vec3(0.8, 0.95, 1.0), 0.5) * dots * underMask * 0.55;
      col += mix(cyan, violet, t) * smoothstep(0.78, 1.0, t) * 0.55;
      col *= 0.82 + 0.18 * smoothstep(-1.5, 0.2, p.y);
    }
    if (mat > 2.5) {
      col = mix(col, vec3(0.02, 0.07, 0.16), 0.3);
      col += violet * fres * 0.36;
    }

    col *= 0.8 + 0.2 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    col *= 0.86 + uPulse * 0.8;

    // a soft bioluminescent halo around the eyes, even on the body shading
    vec3 qq = uInvRot * (p - uOffset);
    float eyeD = min(length(qq - vec3(-0.43, 0.52, 0.42)), length(qq - vec3(0.43, 0.52, 0.42)));
    col *= 0.72 + 0.28 * smoothstep(0.16, 0.3, eyeD);
    return col;
  }

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * vec2(uResolution.x / uResolution.y, 1.0);
    vec3 ro = vec3(0.0, 0.35, 4.3);
    // FOV_SCALE widens the lens so the widest arm pose stays inside the canvas.
    vec3 rd = normalize(vec3(p * ${(1.9 * FOV_SCALE).toFixed(4)}, -4.0));

    // Hit tolerance in world units. The visible height is ~4.1 * FOV_SCALE world
    // units, so a fixed 0.0015 was 0.15 px at display resolution — accurate but
    // wasteful: it forced extra march steps to prove what was already sub-pixel.
    float worldPerPixel = ${(4.1 * FOV_SCALE).toFixed(4)} / max(uResolution.y, 1.0);
    float hitEps = clamp(worldPerPixel * 0.32, 0.0016, 0.005);

    vec3 oc = ro - vec3(0.0, 0.35, 0.0);
    float b = dot(oc, rd);
    float c = dot(oc, oc) - uCullR * uCullR;
    float h = b * b - c;

    vec3 col = vec3(0.0);
    if (h > 0.0) {
      float t = max(0.0, -b - sqrt(h));
      float tEnd = min(-b + sqrt(h), 8.0);
      for (int i = 0; i < MAX_STEPS; i++) {
        vec3 pos = ro + rd * t;
        vec2 hit = map(pos);
        if (hit.x < hitEps && hit.y > 0.0) {
          vec3 n = calcNormal(pos);
          col = shade(pos, n, rd, hit.y);
          break;
        }
        t += max(hit.x * 0.985, 0.0015);
        if (t > tEnd) break;
      }
    }

    col = clamp(col * 1.25, 0.0, 8.0);
    col = col / (1.0 + col);
    col = pow(col, vec3(1.0 / 2.2));
    gl_FragColor = vec4(col, 1.0);
  }
`;
