/** Ray-marched void octopus: one continuous SDF, no assembled tubes. */

export const sdfVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function armCode() {
  let out = ''
  const ra = [0.2, 0.175, 0.15, 0.12, 0.09, 0.06, 0.035]
  const rb = [0.175, 0.15, 0.12, 0.09, 0.06, 0.035, 0.02]
  for (let k = 0; k < 8; k++) {
    for (let i = 0; i < 7; i++) {
      const a = k * 8 + i
      const b = a + 1
      out += `  res = opSmooth(res, vec2(sdCapsule(p, uArmPts[${a}], uArmPts[${b}], ${ra[i].toFixed(3)}, ${rb[i].toFixed(3)}), 2.0), 0.08);\n`
    }
  }
  return out
}

function armInfoCode() {
  let out = ''
  for (let k = 0; k < 8; k++) {
    for (let i = 0; i < 7; i++) {
      const a = k * 8 + i
      const b = a + 1
      out += `
    {
      vec3 a = uArmPts[${a}];
      vec3 b = uArmPts[${b}];
      vec3 ba = b - a;
      vec3 pa = p - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      vec3 closest = a + ba * h;
      vec3 diff = p - closest;
      float d = length(diff);
      if (d < bestD) {
        bestD = d;
        bestT = (${i}.0 + h) / 7.0;
        bestRadial = diff;
        bestTangent = normalize(ba);
      }
    }`
    }
  }
  return out
}

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
    return vec2(d, a.x < b.x ? a.y : b.y);
  }

  vec2 map(vec3 p) {
    vec3 q = rotZ(-uRoll) * rotX(-uPitch) * rotY(-uYaw) * (p - uOffset);

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
    float webR = mix(0.5, 0.78, webT);
    webR += sin(atan(q.z, q.x) * 8.0 + uTime * 0.25) * 0.02;
    float web = abs(length(q.xz) - webR) - 0.016;
    web = max(web, max(q.y - 0.02, -0.3 - q.y));
    body = sminf(body, web, 0.08);

    // funnel / siphon: a short tube with a subtracted opening
    float siphon = sdCapsule(q, vec3(0.0, 0.36, 0.32), vec3(0.0, 0.3, 0.64), 0.06, 0.09);
    float siphonHole = sdCapsule(q, vec3(0.0, 0.35, 0.36), vec3(0.0, 0.31, 0.69), 0.025, 0.055);
    siphon = max(siphon, -siphonHole);
    body = sminf(body, siphon, 0.05);
    vec2 res = vec2(body, 1.0);

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
    vec3 iris = mix(vec3(1.0, 0.86, 0.38), vec3(0.72, 0.38, 0.06), smoothstep(0.03, 0.28, r));
    iris = mix(iris, vec3(0.08, 0.03, 0.006), smoothstep(0.38, 0.47, r));
    float angle = atan(p.y, p.x);
    iris *= 0.82 + 0.18 * (0.5 + 0.5 * sin(angle * 26.0 + r * 34.0 + uTime * 0.5));
    iris += vec3(0.05, 0.32, 0.5) * pow(1.0 - smoothstep(0.04, 0.18, r), 2.0) * 0.4;

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

    vec3 cyan = vec3(0.06, 0.8, 1.0);
    vec3 violet = vec3(0.55, 0.2, 0.95);
    vec3 deep = vec3(0.008, 0.025, 0.075);

    if (mat > 3.5) return eyeColor(p) * 2.3;

    vec3 base = mix(deep, vec3(0.03, 0.09, 0.2), smoothstep(-0.9, 1.1, p.y));
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
      float dots = smoothstep(0.76, 1.0, sin(t * 72.0 + sin(angle * 2.0) * 1.2));
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
    vec3 qq = rotZ(-uRoll) * rotX(-uPitch) * rotY(-uYaw) * (p - uOffset);
    float eyeD = min(length(qq - vec3(-0.43, 0.52, 0.42)), length(qq - vec3(0.43, 0.52, 0.42)));
    col *= 0.72 + 0.28 * smoothstep(0.16, 0.3, eyeD);
    return col;
  }

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * vec2(uResolution.x / uResolution.y, 1.0);
    vec3 ro = vec3(0.0, 0.35, 4.3);
    vec3 rd = normalize(vec3(p * 1.9, -4.0));

    vec3 oc = ro - vec3(0.0, 0.35, 0.0);
    float b = dot(oc, rd);
    float c = dot(oc, oc) - 2.1 * 2.1;
    float h = b * b - c;

    vec3 col = vec3(0.0);
    if (h > 0.0) {
      float t = max(0.0, -b - sqrt(h));
      float tEnd = min(-b + sqrt(h), 8.0);
      for (int i = 0; i < MAX_STEPS; i++) {
        vec3 pos = ro + rd * t;
        vec2 hit = map(pos);
        if (hit.x < 0.0015) {
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
