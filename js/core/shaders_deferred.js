// GLSL for the deferred lighting pipeline (the "Illumination" rework).
//
// Pass 1 (G-buffer): sky, terrain and entities render their surface data into
// three RGBA8 targets + a depth texture (see gbuffer.js for the layout). Normals
// are reconstructed from depth derivatives, so the mesher is untouched.
//
// Pass 2 (composite): a fullscreen shader reads the G-buffer and computes the
// final lit colour. In Phase 1 it reproduces the old forward look exactly; later
// phases add directional sun, coloured point lights, contact shadows, etc.
//
// Material ids match gbuffer.js MAT.* (stored in gLight.a as id/255).

// ---- shared GLSL snippets -------------------------------------------------

// Sky colour for a world-space ray direction: gradient + sun disc/glow, moon,
// and twinkling stars. Shared by the G-buffer sky pass and (later) reflections.
const SKY_GLSL = `
float hash13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }
float starField(vec3 dir, float t){
  vec3 d=dir*90.0; vec3 c=floor(d), f=fract(d);
  float h=hash13(c); if(h<0.975) return 0.0;
  vec3 pp=vec3(hash13(c+1.7),hash13(c+4.3),hash13(c+8.1));
  float dist=length(f-pp);
  float tw=0.6+0.4*sin(t*2.5+h*60.0);
  return smoothstep(0.10,0.0,dist)*tw;
}
vec3 skyColor(vec3 dir, vec3 horizon, vec3 zenith, vec3 sunDir, float dayFactor, float t){
  float h=clamp(dir.y*0.5+0.5,0.0,1.0);
  vec3 col=mix(horizon,zenith,pow(h,0.8));
  float night=clamp(1.0-dayFactor*1.6,0.0,1.0);
  if(night>0.01 && dir.y>0.0) col+=vec3(starField(dir,t)*night*smoothstep(0.0,0.15,dir.y));
  float sd=dot(dir,sunDir);
  float sunDisc=smoothstep(0.9975,0.9990,sd);
  float sunGlow=smoothstep(0.95,1.0,sd)*0.35*dayFactor;
  col+=vec3(1.0,0.93,0.74)*(sunDisc+sunGlow);
  float md=dot(dir,-sunDir);
  float moonDisc=smoothstep(0.9980,0.9992,md);
  float mottle=0.75+0.25*hash13(floor(dir*240.0));
  col+=vec3(0.85,0.88,0.95)*moonDisc*mottle*(0.4+0.6*night);
  return col;
}`;

// ---- volumetric clouds (shared) -------------------------------------------
//
// A single horizontal cloud layer between CLD_BASE and CLD_TOP world-Y. Density
// is fbm value-noise shaped by a coverage threshold and a rounded vertical
// falloff. `renderClouds` ray-marches the slab (with a short sun-march per sample
// for self-shadowing, Beer + powder) and returns PREMULTIPLIED colour + alpha, so
// the caller composites with `base*(1-a) + rgb`. Self-contained (own hash) so it
// can be included alongside SKY_GLSL without symbol clashes; the SAME density
// function drives the ground cloud-shadows in the composite, so shadows line up
// with the clouds you see. Drifts with time (wind).
const CLOUD_GLSL = `
const float CLD_BASE = 118.0;
const float CLD_TOP  = 136.0;
const float CLD_MID  = 127.0;
const vec2  CLD_WIND = vec2(1.1, 0.4);
float chash13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }
float cnoise3(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float n000=chash13(i), n100=chash13(i+vec3(1,0,0));
  float n010=chash13(i+vec3(0,1,0)), n110=chash13(i+vec3(1,1,0));
  float n001=chash13(i+vec3(0,0,1)), n101=chash13(i+vec3(1,0,1));
  float n011=chash13(i+vec3(0,1,1)), n111=chash13(i+vec3(1,1,1));
  float nx00=mix(n000,n100,f.x), nx10=mix(n010,n110,f.x);
  float nx01=mix(n001,n101,f.x), nx11=mix(n011,n111,f.x);
  return mix(mix(nx00,nx10,f.y), mix(nx01,nx11,f.y), f.z);
}
float cloudFbm(vec3 p){
  float a=0.0, w=0.55;
  for(int i=0;i<4;i++){ a+=w*cnoise3(p); p=p*2.03+vec3(1.7,0.0,2.3); w*=0.5; }
  return a;
}
// 0..1 cloud density at a world point; cover 0..1 raises coverage (bigger puffs)
float cloudDensity(vec3 wp, float cover, float t){
  vec3 p = wp*0.0125; p.xz += CLD_WIND*t*0.013;
  float f = cloudFbm(p);
  float hb = smoothstep(CLD_BASE, CLD_BASE+7.0, wp.y);
  float ht = 1.0 - smoothstep(CLD_TOP-10.0, CLD_TOP, wp.y);
  float d = smoothstep(1.0-cover, 1.0-cover+0.30, f) * hb * ht;
  return clamp(d, 0.0, 1.0);
}
// premultiplied (rgb, a) cloud contribution along ray ro+rd (rd normalized)
vec4 renderClouds(vec3 ro, vec3 rd, int steps, float cover, float t,
                  vec3 sunDir, vec3 sunCol, vec3 ambCol, float dayF){
  if(steps<=0 || cover<=0.0 || rd.y<0.02) return vec4(0.0);
  float t0=(CLD_BASE-ro.y)/rd.y, t1=(CLD_TOP-ro.y)/rd.y;
  if(t0>t1){ float s=t0; t0=t1; t1=s; }
  t0=max(t0,0.0); if(t1<=t0) return vec4(0.0);
  t1=min(t1, 6000.0);
  // Adaptive step count: 'steps' is a MAX (spent on long, near-horizon paths).
  // Looking straight up the slab is only ~18 blocks thick, and the finest fbm
  // octave has ~9-block features, so a ~2.6-block step fully resolves it —
  // marching 34 Ultra steps there was ~6x oversampled and made full-sky views
  // (every pixel a sky pixel) tank the frame rate for zero visible gain.
  float seg=t1-t0;
  int n=int(clamp(seg*0.38+1.0, 6.0, float(steps)));
  float dt=seg/float(n);
  float jitter=chash13(rd*137.3)*dt;
  float tr=1.0; vec3 accum=vec3(0.0);
  // bright cumulus: neutral light-grey shadow side, near-white sunlit side,
  // tinted by the sun colour (warm at dusk). Kept bright so clouds read as
  // white puffs, not storm-grey, and never bluer than the sky behind them.
  // (constant per ray — hoisted out of the march; op order kept identical)
  vec3 shadeCol = mix(vec3(0.62,0.64,0.68), ambCol, 0.25);
  vec3 sunCloud = sunCol * 1.15;
  float dayK = 0.32 + 0.68*dayF;
  for(int i=0;i<64;i++){
    if(i>=n) break;
    float tt=t0+dt*float(i)+jitter;
    vec3 wp=ro+rd*tt;
    float d=cloudDensity(wp, cover, t);
    if(d>0.002){
      float ld=0.0;
      for(int j=1;j<=3;j++) ld += cloudDensity(wp+sunDir*float(j)*5.0, cover, t);
      float sun=exp(-ld*0.6);                    // 0 shadowed core .. 1 sunward face
      vec3 lit = mix(shadeCol, sunCloud, sun) * dayK;
      float a=1.0-exp(-d*dt*0.40);
      accum += tr*lit*a;
      tr *= 1.0-a;
      if(tr<0.02) break;
    }
  }
  float alpha=(1.0-tr)*smoothstep(0.02,0.14,rd.y);
  return vec4(accum*smoothstep(0.02,0.14,rd.y), alpha);
}
// ground cloud-shadow: project a surface point up to the cloud mid-plane along the
// sun direction and sample the same density -> moving cloud shadows on terrain.
float cloudShadowAt(vec3 wpos, vec3 sunDir, float cover, float t, float enable){
  if(enable<0.5 || sunDir.y<=0.05) return 1.0;
  float tt=(CLD_MID-wpos.y)/sunDir.y;
  if(tt<=0.0) return 1.0;
  // average two taps through the slab so a whole cloud (not just its mid-slice)
  // casts, then a crisp onset: light wisps barely shade, real clouds shade firmly.
  vec3 base=wpos+sunDir*tt;
  float d=0.5*(cloudDensity(base, cover, t) + cloudDensity(base+sunDir*6.0, cover, t));
  float s=smoothstep(0.04, 0.5, d);
  return 1.0 - s*0.72;
}`;

// ---- G-buffer: sky (fullscreen, fills the background) ---------------------

export const GBUF_SKY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform vec3 uRight, uUp, uFwd;
uniform float uTanHalf, uAspect;
out vec3 vRay;
void main(){
  vRay = uFwd + aPos.x*uTanHalf*uAspect*uRight + aPos.y*uTanHalf*uUp;
  gl_Position = vec4(aPos, 1.0, 1.0);
}`;

export const GBUF_SKY_FS = `#version 300 es
precision highp float;
in vec3 vRay;
uniform vec3 uHorizon, uZenith, uSunDir;
uniform float uDayFactor, uTime;
layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oLight;
layout(location=2) out vec4 oNormal;
${SKY_GLSL}
void main(){
  vec3 dir=normalize(vRay);
  vec3 col=skyColor(dir,uHorizon,uZenith,uSunDir,uDayFactor,uTime);
  oAlbedo=vec4(col,1.0);
  oLight=vec4(0.0,0.0,0.0,1.0);      // matId 255/255 -> sky (unlit, full emissive pass-through)
  oNormal=vec4(0.5,0.5,0.5,0.0);
  // Clouds are marched later, in the composite's sky-pixel branch — only for
  // pixels that actually stay sky, not the many that terrain overwrites.
}`;

// ---- G-buffer: terrain ----------------------------------------------------

export const GBUF_TERRAIN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aShade;
layout(location=3) in float aSky;
layout(location=4) in float aBlock;
layout(location=5) in float aWave;
uniform mat4 uViewProj;
uniform float uTime;
out vec2 vUV;
out float vShade, vSky, vBlock, vMat;
out vec3 vWorld;
void main(){
  vUV=aUV; vShade=aShade; vSky=aSky; vBlock=aBlock;
  vMat = (aWave>0.5 && aWave<1.5) ? 1.0 : 0.0;   // leaves -> foliage material
  vec3 pos=aPos;
  if(aWave>0.5 && aWave<1.5){
    float ph=uTime*1.6+aPos.x*0.7+aPos.z*0.7+aPos.y*0.3;
    pos.x+=sin(ph)*0.045; pos.z+=cos(ph*0.9+1.3)*0.045; pos.y+=sin(ph*1.3)*0.022;
  } else if(aWave>1.5){
    pos.y+=(sin(uTime*0.9+aPos.x*0.7)+sin(uTime*1.27+aPos.z*0.6))*0.03-0.045;
  }
  vWorld=pos;
  gl_Position=uViewProj*vec4(pos,1.0);
}`;

// Sun shadow sampled with the EXACT surface world position (no depth-buffer
// reconstruction — that loses precision at grazing view angles and made flat
// ground self-shadow). Computed in the G-buffer pass and stored in oNormal.a;
// the composite just reads it back. PCF 3x3 for soft edges; normal-offset +
// slope bias (plus the hardware polygonOffset on the map) fight acne.
const SHADOW_FN = `
uniform sampler2D uShadowMap;
uniform mat4 uLightVP;
uniform vec3 uSunDir;
uniform float uShadowEnable, uShadowTexel, uShadowTexelWorld, uShadowBias;
float sunShadowAt(vec3 wpos, vec3 N){
  float ndl = max(dot(N, uSunDir), 0.0);
  if(uShadowEnable < 0.5 || ndl <= 0.0) return 1.0;
  float off = uShadowTexelWorld * (1.5 + 2.0*(1.0-ndl));
  vec3 op = wpos + N*off;
  vec4 lc = uLightVP*vec4(op,1.0);
  vec3 p = lc.xyz/lc.w*0.5+0.5;
  if(p.z>1.0 || p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0) return 1.0;
  float slope = sqrt(max(0.0,1.0-ndl*ndl))/max(ndl,0.2);
  float bias = clamp(uShadowBias*slope, uShadowBias*0.5, uShadowBias*5.0);
  float zref = p.z - bias;
  float sh = 0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++)
    sh += zref <= texture(uShadowMap, p.xy+vec2(float(x),float(y))*uShadowTexel).r ? 1.0 : 0.0;
  return sh/9.0;
}`;

export const GBUF_TERRAIN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vShade, vSky, vBlock, vMat;
in vec3 vWorld;
uniform sampler2D uAtlas;
layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oLight;
layout(location=2) out vec4 oNormal;
void main(){
  vec4 tex=texture(uAtlas,vUV);
  if(tex.a<0.5) discard;
  vec3 n=normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  oAlbedo=vec4(tex.rgb, vShade);
  oLight=vec4(vSky, vBlock, 0.0, vMat/255.0);
  oNormal=vec4(n*0.5+0.5, 1.0);
}`;

// ---- G-buffer: entities ---------------------------------------------------

// aSky doubles as a BONE INDEX for animated mobs (lighting uses the uSky/uBlock
// uniforms, so the attribute was free). uBones[i] = (pivot.xyz, angle): vertices
// tagged with bone i rotate about the local X axis through that pivot — enough
// for leg/arm walk swings and head nods. Bone 0 is static (drops, boats, ...).
export const ENTITY_BONES = 6;

const BONE_GLSL = `
uniform vec4 uBones[6];
vec3 bonePos(vec3 p, float bi){
  int i=int(bi+0.5);
  if(i<=0) return p;
  vec4 b=uBones[i];
  float c=cos(b.w), s=sin(b.w);
  vec3 q=p-b.xyz;
  return b.xyz+vec3(q.x, c*q.y-s*q.z, s*q.y+c*q.z);
}`;

export const GBUF_ENTITY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aShade;
layout(location=3) in float aSky;
layout(location=4) in float aBlock;
uniform mat4 uViewProj, uModel;
${BONE_GLSL}
out vec2 vUV;
out float vShade;
out vec3 vWorld, vCol;
void main(){
  vUV=aUV; vShade=aShade; vCol=vec3(aUV,aBlock);
  vec4 wp=uModel*vec4(bonePos(aPos,aSky),1.0);
  vWorld=wp.xyz;
  gl_Position=uViewProj*wp;
}`;

export const GBUF_ENTITY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vShade;
in vec3 vWorld, vCol;
uniform sampler2D uAtlas;
uniform float uTextured, uSky, uBlock;
uniform vec3 uTint;
layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oLight;
layout(location=2) out vec4 oNormal;
void main(){
  vec3 base;
  if(uTextured>0.5){ vec4 t=texture(uAtlas,vUV); if(t.a<0.5) discard; base=t.rgb; }
  else base=uTint*vCol;
  vec3 n=normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  oAlbedo=vec4(base, vShade);
  oLight=vec4(uSky, uBlock, 0.0, 3.0/255.0);   // matId 3 = entity
  oNormal=vec4(n*0.5+0.5, 1.0);
}`;

// ---- sun shadow map (depth-only, from the sun's point of view) ------------
//
// Terrain casts cutout-accurate shadows (leaves discard transparent texels so
// their shadows are dappled, not solid quads). Entities reuse their mesh with a
// per-instance model matrix. The composite samples this with PCF for soft edges.

export const SHADOW_TERRAIN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=5) in float aWave;
uniform mat4 uLightVP;
uniform float uTime;
out vec2 vUV;
void main(){
  vUV=aUV;
  vec3 pos=aPos;                       // match the terrain VS wave so shadows track motion
  if(aWave>0.5 && aWave<1.5){
    float ph=uTime*1.6+aPos.x*0.7+aPos.z*0.7+aPos.y*0.3;
    pos.x+=sin(ph)*0.045; pos.z+=cos(ph*0.9+1.3)*0.045; pos.y+=sin(ph*1.3)*0.022;
  }
  gl_Position=uLightVP*vec4(pos,1.0);
}`;

export const SHADOW_TERRAIN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uAtlas;
void main(){ if(texture(uAtlas,vUV).a<0.5) discard; }`;

// uCutout: textured entity meshes (dropped items) discard transparent texels so
// a dropped sword shadows as a sword, not as its bounding quad. Untextured mob
// meshes pack colours into the UV slots, so they must draw with uCutout=0.
export const SHADOW_ENTITY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=3) in float aSky;
uniform mat4 uLightVP, uModel;
${BONE_GLSL}
out vec2 vUV;
void main(){ vUV=aUV; gl_Position=uLightVP*uModel*vec4(bonePos(aPos,aSky),1.0); }`;

export const SHADOW_ENTITY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uAtlas;
uniform float uCutout;
void main(){ if(uCutout>0.5 && texture(uAtlas,vUV).a<0.5) discard; }`;

// ---- fullscreen helpers ---------------------------------------------------

// A fullscreen triangle; passes through a 0..1 uv for buffer sampling.
export const FULLSCREEN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }`;

// ---- composite / lighting -------------------------------------------------
//
// Reconstructs world position + normal from the G-buffer and lights the surface
// from: a directional sun/moon (with screen-space contact shadows), a soft sky
// ambient (gated by baked skylight = sky exposure), a warm baked block-light
// fill, and a list of coloured dynamic point lights (held torch + nearby
// emitters), each attenuated and contact-shadowed. Colours are first-class so
// future coloured glass / fire just feed different light colours.

const MAX_LIGHTS = 16;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAlbedo, uLight, uNormal, uDepth;
uniform sampler2D uShadowMap;
uniform mat4 uViewProj, uLightVP;
uniform vec3 uCamPos, uFogColor;
uniform vec3 uCamRight, uCamUp, uCamFwd;   // camera basis (world space)
uniform float uTanHalf, uAspect, uNear, uFar;
uniform float uFogNear, uFogFar;
uniform vec3 uSunDir, uSunColor, uSkyAmbient, uBlockColor;
uniform float uSunStrength;
uniform float uDaylight;           // sky.daylight() 0.12..1.0 — day/night skylight exposure
uniform float uShadowEnable;       // 1 = sun shadow map active
uniform float uShadowTexel;        // 1/shadowMapSize, for PCF tap spacing
uniform float uShadowTexelWorld;   // world size of one shadow texel (normal-offset bias)
uniform float uShadowBias;         // depth bias to fight acne
uniform int uShadowSteps;          // point-light contact-shadow steps (0 = off)
uniform float uShadowDist;         // world-space march length for point lights
uniform sampler2D uSSAO;           // blurred screen-space AO (1 = no occlusion)
uniform float uDebug;              // 1 = show AO term; 2 = show sun shadow term
uniform int uLightCount;
uniform vec3 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightColor[${MAX_LIGHTS}];
uniform float uLightRad[${MAX_LIGHTS}];
uniform float uLightShadow;        // 1 = contact-shadow point lights too
uniform float uTime, uCloudCover, uCloudShadow;   // moving cloud shadows on terrain
uniform int uCloudSteps;           // volumetric cloud march steps (0 = clouds off)
uniform vec3 uCloudSunDir, uCloudAmb;   // true sun dir + ambient sky fill for clouds
uniform float uCloudDay;           // sky.dayFactor() for cloud brightness
out vec4 frag;
${CLOUD_GLSL}

// Reconstruct world position from the depth buffer via a camera ray + linearised
// depth. This is numerically MUCH stabler than inverting the view-proj matrix:
// perspective depth bunches up near 1.0, and a full-matrix unproject in float32
// then loses several blocks of precision in the near/mid field (which corrupted
// the shadow/fog lookups). Isolating the non-linearity into one well-conditioned
// division keeps the reconstruction accurate at all distances.
vec3 worldFromDepth(vec2 uv, float d){
  vec2 ndc = uv*2.0-1.0;
  vec3 ray = uCamFwd + ndc.x*uTanHalf*uAspect*uCamRight + ndc.y*uTanHalf*uCamUp; // forward-dist 1
  float zc = d*2.0-1.0;
  float linDist = (2.0*uNear*uFar) / (uFar+uNear - zc*(uFar-uNear));             // view-fwd distance
  return uCamPos + ray*linDist;
}

// March from a surface point toward a light in world space, projecting each step
// to screen and comparing camera distance against the stored depth: if real
// geometry sits in front of the marched point (within a thickness), it occludes.
// Returns a SOFT factor in [1-strength .. 1]: occluders hit early (close to the
// surface) shadow more, and the shadow fades out along the ray, so the result is
// a gentle contact shadow rather than a hard binary edge.
float contactShadow(vec3 wpos, vec3 L, float maxDist, int steps){
  float dt = maxDist / float(steps);
  float t = dt * 0.5 + 0.03;
  for(int i=0;i<32;i++){
    if(i>=steps) break;
    vec3 p = wpos + L*t;
    vec4 cs = uViewProj*vec4(p,1.0);
    if(cs.w<=0.0) break;
    vec2 uv = (cs.xy/cs.w)*0.5+0.5;
    if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) break;
    float sd = texture(uDepth, uv).r;
    if(sd<1.0){
      vec3 sPos = worldFromDepth(uv, sd);
      float dP = distance(p, uCamPos);
      float dS = distance(sPos, uCamPos);
      if(dS < dP-0.04 && (dP-dS) < 1.0){
        float closeness = 1.0 - t/maxDist;          // stronger near the surface
        return 1.0 - 0.7*closeness*closeness;       // soft, max ~70% darkening
      }
    }
    t += dt;
  }
  return 1.0;
}

// Sun cast-shadow from the depth shadow map. Reconstructed world pos (accurate)
// is pushed off the surface along N by a couple of texels (NORMAL-OFFSET bias) so
// flat lit ground doesn't self-shadow; a slope-scaled depth bias handles the rest.
// 3x3 PCF softens the edge; the term fades smoothly to fully-lit at the map border
// so the finite shadow range has no visible boundary. Returns 1 (lit) .. 0 (shadow).
float sunShadow(vec3 wpos, vec3 N, float ndl){
  if(uShadowEnable < 0.5 || ndl <= 0.0) return 1.0;
  float off = uShadowTexelWorld * (3.0 + 4.0*(1.0-ndl));
  vec4 lc = uLightVP*vec4(wpos + N*off, 1.0);
  vec3 p = lc.xyz/lc.w*0.5+0.5;
  if(p.z>1.0) return 1.0;
  // smooth border fade (outer ~8% of the map) -> no hard range boundary
  vec2 f = smoothstep(0.0,0.08,p.xy) * (1.0 - smoothstep(0.92,1.0,p.xy));
  float edge = f.x*f.y;
  if(edge<=0.0) return 1.0;
  float slope = sqrt(max(0.0,1.0-ndl*ndl))/max(ndl,0.2);
  float bias = clamp(uShadowBias*slope, uShadowBias*0.5, uShadowBias*4.0);
  float zref = p.z - bias;
  float sh = 0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++)
    sh += zref <= texture(uShadowMap, p.xy+vec2(float(x),float(y))*uShadowTexel).r ? 1.0 : 0.0;
  return mix(1.0, sh/9.0, edge);
}

void main(){
  vec4 A=texture(uAlbedo,vUv);
  vec3 albedo=A.rgb;
  vec4 L=texture(uLight,vUv);
  if(L.a>=0.99){                                       // sky / background (matId 255)
    // march clouds only here — sky pixels that survived the depth test — so the
    // layer costs nothing on the (typically large) part of the screen that terrain
    // covers. Reconstruct the world-space view ray for this pixel.
    vec2 ndc=vUv*2.0-1.0;
    vec3 dir=normalize(uCamFwd + ndc.x*uTanHalf*uAspect*uCamRight + ndc.y*uTanHalf*uCamUp);
    vec4 cl=renderClouds(uCamPos,dir,uCloudSteps,uCloudCover,uTime,uCloudSunDir,uSunColor,uCloudAmb,uCloudDay);
    frag=vec4(albedo*(1.0-cl.a)+cl.rgb, 1.0);
    return;
  }

  float depth=texture(uDepth,vUv).r;
  float shade=A.a;                                     // baked face-shade * vertex AO
  float sky=L.r, block=L.g;
  vec3 N=normalize(texture(uNormal,vUv).rgb*2.0-1.0);
  vec3 wpos=worldFromDepth(vUv, depth);

  // --- occlusion: the baked voxel face-shade (top bright / sides darker / vertex
  // AO) is the PRIMARY contrast, exactly like the old forward look; the screen-
  // space SSAO multiplies into it to deepen corners the baked AO can't see. Kept
  // at full strength (not softened) so blocks read crisp and dimensional. ---
  float ssao = texture(uSSAO, vUv).r;                  // blurred AO from its own pass
  if(uDebug>0.5){
    if(uDebug<1.5){ frag=vec4(vec3(ssao),1.0); return; }              // debug 1: AO term
    float ndlD=max(dot(N,uSunDir),0.0);
    frag=vec4(vec3(sunShadow(wpos,N,ndlD)),1.0); return;              // debug 2: shadow term
  }
  float occ = shade * ssao;

  // --- daylight skylight exposure (ambient-floored max(blocklight, skylight*
  // daylight)) so dawn/dusk/night dim and the scene never washes past the texture
  // colour. (This is the look that was dialled in and approved.) ---
  float baseLight = max(block, sky*uDaylight);
  float b = 0.06 + 0.94*baseLight;
  vec3 col = albedo * occ * b;

  // --- warm directional sun on sky-lit faces turned toward the sun, attenuated by
  // the cast-shadow term (so shadows read as a loss of direct sun while the sky
  // ambient still fills them). Kept moderate so it adds shape + shadow contrast
  // without the blowout/over-darkening of a full relight. ---
  float ndl = max(dot(N, uSunDir), 0.0);
  float sunLit = ndl * smoothstep(0.05, 0.45, sky) * uSunStrength;
  // Skip the whole shadow evaluation when the pixel receives no direct sun
  // anyway (faces turned away, cave interiors with sky<=0.05, sun strength 0):
  // the term below multiplies to exactly zero, but the 3x3 PCF fetches and the
  // two cloud-density fbm's are the most expensive per-pixel work in this shader.
  if (sunLit > 0.0) {
    float shadow = sunShadow(wpos, N, ndl) * cloudShadowAt(wpos, uCloudSunDir, uCloudCover, uTime, uCloudShadow);
    col += albedo * occ * uSunColor * (sunLit * 0.30 * shadow);
  }

  // --- coloured point lights (held torch + nearby emitters): additive, tinted by
  // the surface albedo, attenuated, AO-respecting. Colours are first-class for
  // future coloured glass / fire. Damped on surfaces already in bright daylight
  // (a torch shouldn't visibly over-brighten noon grass — light maxes out, like
  // the baked max(block, sky) term); at night and underground it's unchanged. ---
  float dayDamp = 1.0 - 0.72*uDaylight*smoothstep(0.35, 0.9, sky);
  for(int i=0;i<${MAX_LIGHTS};i++){
    if(i>=uLightCount) break;
    vec3 d = uLightPos[i]-wpos;
    float dist = length(d);
    float r = uLightRad[i];
    if(dist>=r) continue;
    vec3 Ld = d/max(dist,1e-3);
    float at = 1.0 - dist/r; at*=at;                   // smooth quadratic falloff
    float ndlP = max(dot(N,Ld),0.0)*0.75 + 0.25;       // wrapped so facing-away isn't black
    float sh = 1.0;
    if(uLightShadow>0.5 && uShadowSteps>0)
      sh = contactShadow(wpos, Ld, min(r,dist), uShadowSteps/2);
    col += albedo * occ * uLightColor[i]*(at*ndlP*sh*dayDamp);
  }

  float dist=distance(wpos, uCamPos);
  float fog=clamp((dist-uFogNear)/(uFogFar-uFogNear),0.0,1.0);
  col=mix(col, uFogColor, fog);
  frag=vec4(col,1.0);
}`;

// ---- SSAO (dedicated pass + blur) -----------------------------------------
//
// Computing SSAO in its own pass lets us BLUR the result, which removes the
// per-pixel rotation grain that an inline (un-blurred) SSAO leaves behind. The
// AO term is written to a single buffer, then a depth-aware box blur cleans it,
// and the composite just samples the smooth result.

export const SSAO_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDepth, uNormal;
uniform mat4 uViewProj;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalf, uAspect, uNear, uFar;
uniform int uSamples;
uniform float uRadius, uStrength;
out vec4 frag;
vec3 worldFromDepth(vec2 uv, float d){
  vec2 ndc=uv*2.0-1.0;
  vec3 ray=uCamFwd + ndc.x*uTanHalf*uAspect*uCamRight + ndc.y*uTanHalf*uCamUp;
  float zc=d*2.0-1.0;
  float linDist=(2.0*uNear*uFar)/(uFar+uNear - zc*(uFar-uNear));
  return uCamPos + ray*linDist;
}
float hash12(vec2 p){ vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
void main(){
  float d=texture(uDepth,vUv).r;
  if(d>=1.0){ frag=vec4(1.0); return; }                 // sky -> no AO
  vec3 N=normalize(texture(uNormal,vUv).rgb*2.0-1.0);
  vec3 wpos=worldFromDepth(vUv,d);
  vec3 rv=normalize(vec3(hash12(vUv*131.7)*2.0-1.0, hash12(vUv*71.3+5.1)*2.0-1.0, hash12(vUv*43.9+9.7)));
  vec3 T=normalize(rv - N*dot(rv,N));
  vec3 B=cross(N,T);
  float occ=0.0;
  for(int i=0;i<32;i++){
    if(i>=uSamples) break;
    float fi=float(i)+0.5;
    vec3 h=normalize(vec3(hash12(vec2(fi,1.3))*2.0-1.0, hash12(vec2(fi,2.7))*2.0-1.0, hash12(vec2(fi,3.9))*0.85+0.15));
    float scale=fi/float(uSamples); scale=mix(0.12,1.0,scale*scale);
    vec3 sp=wpos + (T*h.x+B*h.y+N*h.z)*uRadius*scale;
    vec4 cs=uViewProj*vec4(sp,1.0);
    if(cs.w<=0.0) continue;
    vec2 suv=cs.xy/cs.w*0.5+0.5;
    if(suv.x<0.0||suv.x>1.0||suv.y<0.0||suv.y>1.0) continue;
    float sd=texture(uDepth,suv).r;
    if(sd>=1.0) continue;
    vec3 op=worldFromDepth(suv,sd);
    float rangeCheck=1.0 - smoothstep(uRadius*0.5, uRadius, distance(op,wpos));
    if(distance(op,uCamPos) < distance(sp,uCamPos) - 0.03) occ += rangeCheck;
  }
  float ao=1.0 - (occ/float(uSamples))*uStrength;
  frag=vec4(clamp(ao,0.0,1.0));
}`;

// Depth-aware 5x5 box blur: averages the AO over a neighbourhood (killing the
// dithering grain) but weights down samples across a depth step so AO doesn't
// bleed over silhouette edges. Depth is linearised so the threshold is in blocks.
export const SSAO_BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSSAO, uDepth;
uniform vec2 uTexel;
uniform float uNear, uFar;
out vec4 frag;
float lin(float d){ return (2.0*uNear*uFar)/(uFar+uNear-(d*2.0-1.0)*(uFar-uNear)); }
void main(){
  float dc=lin(texture(uDepth,vUv).r);
  float sum=0.0, wsum=0.0;
  for(int y=-2;y<=2;y++) for(int x=-2;x<=2;x++){
    vec2 uv=vUv+vec2(float(x),float(y))*uTexel;
    float dn=lin(texture(uDepth,uv).r);
    float w=exp(-abs(dn-dc)*1.5);                        // reject across ~1-block depth steps
    sum+=texture(uSSAO,uv).r*w; wsum+=w;
  }
  frag=vec4(sum/max(wsum,1e-4));
}`;

// ---- water with screen-space reflections (SSR) ----------------------------
//
// Water draws forward (translucent, over the already-lit opaque scene). For
// reflections it reflects the view ray off the rippled water normal and marches
// the scene DEPTH buffer; on a hit it samples a COPY of the lit scene (blitted
// before the water pass, so we never read the buffer we're writing). Misses (the
// ray escaping to the sky, or off-screen) fall back to the procedural sky colour,
// so there's always a plausible reflection. A Fresnel term ramps reflection up at
// grazing angles (where real water turns mirror-like) and keeps it low looking
// straight down (where you see through to the bottom).

export const WATER_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aShade;
layout(location=3) in float aSky;
layout(location=4) in float aBlock;
layout(location=5) in float aWave;
uniform mat4 uViewProj;
uniform float uTime;
out vec2 vUV;
out float vShade, vSky, vBlock;
out vec3 vWorld;
void main(){
  vUV=aUV; vShade=aShade; vSky=aSky; vBlock=aBlock;
  vec3 pos=aPos;
  if(aWave>1.5){ pos.y += (sin(uTime*0.9+aPos.x*0.7)+sin(uTime*1.27+aPos.z*0.6))*0.03 - 0.045; }
  vWorld=pos;
  gl_Position=uViewProj*vec4(pos,1.0);
}`;

export const WATER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vShade, vSky, vBlock;
in vec3 vWorld;
uniform sampler2D uAtlas, uReflect, uDepth;
uniform mat4 uViewProj;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalf, uAspect, uNear, uFar;
uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
uniform float uDaylight, uTime;
uniform vec3 uHorizon, uZenith, uSunDir, uSunColor; uniform float uDayFactor;
uniform int uSSRSteps, uCloudSteps;
uniform float uReflStrength, uCloudCover;
out vec4 frag;
${SKY_GLSL}
${CLOUD_GLSL}
vec3 worldFromDepth(vec2 uv, float d){
  vec2 ndc=uv*2.0-1.0;
  vec3 ray=uCamFwd + ndc.x*uTanHalf*uAspect*uCamRight + ndc.y*uTanHalf*uCamUp;
  float zc=d*2.0-1.0;
  float linDist=(2.0*uNear*uFar)/(uFar+uNear - zc*(uFar-uNear));
  return uCamPos + ray*linDist;
}
void main(){
  vec4 tex=texture(uAtlas,vUV);
  if(tex.a<0.5) discard;
  float light=max(vBlock, vSky*uDaylight);
  float b=0.07+0.93*light;
  vec3 base=tex.rgb*vShade*b;

  // Animated ripple normal. Several non-harmonic waves per axis, so the
  // perturbation shimmers organically instead of orbiting in circles (the old
  // single sin/cos pair swept every reflected feature around a little ellipse).
  // The amplitude fades with distance: far water flattens toward a mirror,
  // which also keeps the SSR ray stable so distant reflections don't wobble.
  float t=uTime;
  float gx = sin(vWorld.x*1.9  + t*1.50)*0.5
           + sin(vWorld.x*0.83 + vWorld.z*1.31 + t*1.03)*0.3
           + sin(vWorld.z*2.71 + t*0.67)*0.2;
  float gz = cos(vWorld.z*1.7  + t*1.27)*0.5
           + cos(vWorld.x*1.49 - vWorld.z*0.77 + t*0.89)*0.3
           + cos(vWorld.x*2.33 + t*1.51)*0.2;
  float distV = distance(vWorld, uCamPos);
  float ampl = 0.05 / (1.0 + distV*0.05);
  vec3 N=normalize(vec3(gx*ampl, 1.0, gz*ampl));

  vec3 V=normalize(vWorld-uCamPos);
  vec3 R=reflect(V,N);
  // a reflection ray can only come from above the surface; a ripple at a grazing
  // view can tip R below horizontal, which used to dive into the lake bed
  if(R.y<0.02){ R.y=0.02; R=normalize(R); }

  // SSR march through the scene depth buffer. When a sample lands behind
  // above-water geometry we BISECT between the previous and current sample to
  // pin the exact silhouette, instead of demanding the coarse sample itself sit
  // within a thickness window. Thin features (tree trunks, mobs, fence-width
  // shapes) used to slip between the growing steps, so half the pixels of a
  // tree's mirror image missed and fell back to the bright sky/cloud colour —
  // which is what washed the reflections out after clouds joined the fallback.
  bool hit=false; vec2 huv;
  float march=0.3, step=0.35, prev=0.3;
  for(int i=0;i<48;i++){
    if(i>=uSSRSteps) break;
    vec3 sp=vWorld+R*march;
    vec4 cs=uViewProj*vec4(sp,1.0);
    if(cs.w<=0.0) break;
    vec2 uv=cs.xy/cs.w*0.5+0.5;
    if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) break;
    float sd=texture(uDepth,uv).r;
    if(sd<1.0){
      vec3 scenePos=worldFromDepth(uv,sd);
      // Only geometry ABOVE the water plane can appear in a reflection. The
      // depth buffer contains the lake bed / shore UNDER the translucent
      // surface, and accepting those hits painted drifting sand-coloured
      // blobs onto the water.
      if(scenePos.y > vWorld.y + 0.05){
        float dS=distance(scenePos,uCamPos), dP=distance(sp,uCamPos);
        if(dS<dP-0.05){
          // crossed behind geometry: bisect [prev, march] down to the surface
          float lo=prev, hi=march;
          for(int r=0;r<5;r++){
            float mid=(lo+hi)*0.5;
            vec3 bp=vWorld+R*mid;
            vec4 bc=uViewProj*vec4(bp,1.0);
            vec2 bu=bc.xy/bc.w*0.5+0.5;
            float bd=texture(uDepth,bu).r;
            vec3 bs=worldFromDepth(bu,bd);
            if(bd<1.0 && distance(bs,uCamPos) < distance(bp,uCamPos)){ hi=mid; uv=bu; sd=bd; }
            else lo=mid;
          }
          vec3 fp=vWorld+R*hi;
          vec3 fs=worldFromDepth(uv,sd);
          float fD=distance(fp,uCamPos)-distance(fs,uCamPos);
          // accept if the refined point sits on the surface (small residual,
          // scaled with distance for far hits) and is still above the plane
          if(fs.y > vWorld.y + 0.05 && fD < 0.75 + distance(fp,uCamPos)*0.02){
            hit=true; huv=uv; break;
          }
        }
      }
    }
    prev=march; march+=step; step*=1.18;
  }
  vec3 skyRefl=skyColor(R, uHorizon, uZenith, uSunDir, uDayFactor, uTime);
  // Reflect the clouds too (cheaper march), so the sky mirror stays consistent —
  // but SOFTENED: at full strength the white cumulus fallback was so bright it
  // visually drowned the geometry hits next to it (tree mirrors read as haze).
  vec3 amb=mix(uHorizon,uZenith,0.5)*1.1;
  vec4 rcl=renderClouds(vWorld, R, uCloudSteps, uCloudCover, uTime, uSunDir, uSunColor, amb, uDayFactor);
  rcl *= 0.55;
  skyRefl = skyRefl*(1.0-rcl.a) + rcl.rgb;
  vec3 refl=skyRefl;
  if(hit){
    // fade the screen-space hit toward the sky reflection near the edges (where
    // the marched ray runs off-screen) to hide the SSR cutoff seam. The band is
    // deliberately narrow: reflected treetops land near the TOP of the screen,
    // and a wide fade there swapped their mirror for bright cloudy sky.
    vec2 e=smoothstep(0.0,0.05,huv)*(1.0-smoothstep(0.95,1.0,huv));
    refl=mix(skyRefl, texture(uReflect,huv).rgb, e.x*e.y);
  }

  float fres=0.04+0.96*pow(1.0-max(dot(-V,N),0.0), 5.0);
  // geometry mirrors get a small boost over the sky fallback: a tree/shore
  // reflection should read clearly, while open-sky glare stays as before
  float rs=fres*uReflStrength*(hit?1.35:1.0);
  vec3 col=mix(base, refl, clamp(rs, 0.0, 0.92));

  float dist=distance(vWorld,uCamPos);
  float fog=clamp((dist-uFogNear)/(uFogFar-uFogNear),0.0,1.0);
  col=mix(col,uFogColor,fog);
  frag=vec4(col, 0.85);
}`;

// ---- god-rays (volumetric light scattering as a post-process) -------------
//
// For each pixel, march toward the sun's screen position sampling the depth
// buffer; sky texels (depth==1) along the path scatter light, geometry occludes
// it. Accumulated with exponential decay this gives radial shafts streaming past
// silhouettes (leaves, hills). Run at half-res; the bilinear upscale softens it.
// (Mitchell, GPU Gems 3 — "Volumetric Light Scattering as a Post-Process".)

export const GODRAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDepth;
uniform vec2 uSunScreen;       // sun position in uv space (may lie outside 0..1)
uniform vec3 uSunColor;
uniform float uGodrayValid;    // 0..1: sun in front of camera, above horizon, near screen
uniform float uGodrayStrength;
uniform int uGodraySamples;
out vec4 frag;
void main(){
  if(uGodrayValid<=0.0 || uGodraySamples<=0){ frag=vec4(0.0,0.0,0.0,1.0); return; }
  vec2 delta = (uSunScreen - vUv) / float(uGodraySamples) * 0.92;
  vec2 uv = vUv;
  float illum = 1.0, accum = 0.0;
  for(int i=0;i<96;i++){
    if(i>=uGodraySamples) break;
    uv += delta;
    if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) break;
    float d = texture(uDepth, uv).r;
    accum += (d>=0.9999 ? 1.0 : 0.0) * illum;
    illum *= 0.955;                                  // decay along the ray
  }
  accum /= float(uGodraySamples);
  frag = vec4(uSunColor * (accum * uGodrayStrength * uGodrayValid), 1.0);
}`;

// ---- final present: copy the lit buffer to the screen (upscales render scale) ----

export const PRESENT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex, uGodray, uDepth;
uniform float uGodrayEnable;
uniform float uUnderwater;          // 0..1 strength of the submerged effect
uniform float uTime, uNear, uFar;
uniform vec3 uWaterTint;
out vec4 frag;
void main(){
  vec2 uv = vUv;
  // submerged: a slow refractive wobble of the whole image
  if(uUnderwater > 0.001){
    uv += vec2(sin(uv.y*16.0 + uTime*1.6), cos(uv.x*14.0 + uTime*1.3)) * 0.0035 * uUnderwater;
    uv = clamp(uv, 0.0, 1.0);
  }
  vec3 c = texture(uTex,uv).rgb;
  c += uGodrayEnable * texture(uGodray,uv).rgb;     // additive light shafts
  // The composite is energy-bounded (diffuse <= ~albedo), so we keep tones LINEAR
  // below 1.0 (preserving the crisp textured contrast of the old look) and only
  // softly roll off the rare overshoot above 1.0 (bright torches / god-ray shafts)
  // instead of clipping it to flat white.
  vec3 over = max(c - 1.0, 0.0);
  c = min(c, vec3(1.0)) + over/(1.0 + over);

  // ---- underwater: blue murk that thickens with distance, a dim blue cast and a
  // soft vignette so being submerged reads clearly instead of looking like air ----
  if(uUnderwater > 0.001){
    float d = texture(uDepth, uv).r;
    float lin = (2.0*uNear*uFar) / (uFar + uNear - (d*2.0-1.0)*(uFar-uNear));
    float murk = clamp(1.0 - exp(-lin*0.12), 0.0, 0.95) * uUnderwater;
    c = mix(c, uWaterTint, murk);                              // distance fog -> deep water colour
    c = mix(c, c*vec3(0.55,0.82,1.05), 0.40*uUnderwater);      // cool blue cast
    c *= mix(1.0, 0.80, uUnderwater);                          // overall dim
    vec2 q = vUv - 0.5;
    float vig = smoothstep(0.85, 0.30, length(q));
    c *= mix(1.0, vig, 0.45*uUnderwater);                      // darken the edges
  }
  frag = vec4(c, 1.0);
}`;
