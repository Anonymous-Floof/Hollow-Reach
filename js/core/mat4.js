// Minimal column-major 4x4 matrix + vec3 helpers. No external math library.

export const mat4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  identity(o) {
    o.fill(0);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },

  // Right-handed perspective, depth in [-1, 1].
  perspective(o, fovyRad, aspect, near, far) {
    const f = 1 / Math.tan(fovyRad / 2);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = (far + near) / (near - far);
    o[11] = -1;
    o[14] = (2 * far * near) / (near - far);
    return o;
  },

  // Orthographic projection, depth in [-1, 1]. Used for the sun's shadow camera.
  ortho(o, l, r, b, t, n, f) {
    o.fill(0);
    o[0] = 2 / (r - l);
    o[5] = 2 / (t - b);
    o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l);
    o[13] = -(t + b) / (t - b);
    o[14] = -(f + n) / (f - n);
    o[15] = 1;
    return o;
  },

  // Right-handed lookAt view matrix (camera looks from eye toward center).
  lookAt(o, eye, center, up) {
    let fx = center[0] - eye[0], fy = center[1] - eye[1], fz = center[2] - eye[2];
    let fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let sx = fy * up[2] - fz * up[1], sy = fz * up[0] - fx * up[2], sz = fx * up[1] - fy * up[0];
    let sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
    const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    o[0] = sx; o[1] = ux; o[2] = -fx; o[3] = 0;
    o[4] = sy; o[5] = uy; o[6] = -fy; o[7] = 0;
    o[8] = sz; o[9] = uz; o[10] = -fz; o[11] = 0;
    o[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
    o[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    o[14] = (fx * eye[0] + fy * eye[1] + fz * eye[2]);
    o[15] = 1;
    return o;
  },

  // out = a * b
  multiply(o, a, b) {
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
    const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
    const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
    const a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    for (let i = 0; i < 4; i++) {
      const b0=b[i*4],b1=b[i*4+1],b2=b[i*4+2],b3=b[i*4+3];
      o[i*4]   = b0*a00 + b1*a10 + b2*a20 + b3*a30;
      o[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
      o[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
      o[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
    }
    return o;
  },

  translate(o, x, y, z) {
    mat4.identity(o);
    o[12] = x; o[13] = y; o[14] = z;
    return o;
  },

  // out = inverse(a). Returns o, or null if a is singular. Used to unproject the
  // depth buffer back to world space in the deferred lighting pass.
  invert(o, a) {
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
    const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
    const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
    const a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10;
    const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
    const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30;
    const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) return null;
    det = 1.0/det;
    o[0]=(a11*b11-a12*b10+a13*b09)*det;
    o[1]=(a02*b10-a01*b11-a03*b09)*det;
    o[2]=(a31*b05-a32*b04+a33*b03)*det;
    o[3]=(a22*b04-a21*b05-a23*b03)*det;
    o[4]=(a12*b08-a10*b11-a13*b07)*det;
    o[5]=(a00*b11-a02*b08+a03*b07)*det;
    o[6]=(a32*b02-a30*b05-a33*b01)*det;
    o[7]=(a20*b05-a22*b02+a23*b01)*det;
    o[8]=(a10*b10-a11*b08+a13*b06)*det;
    o[9]=(a01*b08-a00*b10-a03*b06)*det;
    o[10]=(a30*b04-a31*b02+a33*b00)*det;
    o[11]=(a21*b02-a20*b04-a23*b00)*det;
    o[12]=(a11*b07-a10*b09-a12*b06)*det;
    o[13]=(a00*b09-a01*b07+a02*b06)*det;
    o[14]=(a31*b01-a30*b03-a32*b00)*det;
    o[15]=(a20*b03-a21*b01+a22*b00)*det;
    return o;
  },

  rotateX(o, r) {
    mat4.identity(o);
    const c = Math.cos(r), s = Math.sin(r);
    o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
    return o;
  },

  rotateY(o, r) {
    mat4.identity(o);
    const c = Math.cos(r), s = Math.sin(r);
    o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
    return o;
  },

  // Model matrix = translate(x,y,z) · rotateY(yaw) · scale(sc). Column-major,
  // translation in the last column. Used to place entity meshes in the world.
  modelMatrix(o, x, y, z, yaw, sc = 1) {
    const c = Math.cos(yaw) * sc, s = Math.sin(yaw) * sc;
    o[0] = c;  o[1] = 0;   o[2] = -s; o[3] = 0;
    o[4] = 0;  o[5] = sc;  o[6] = 0;  o[7] = 0;
    o[8] = s;  o[9] = 0;   o[10] = c; o[11] = 0;
    o[12] = x; o[13] = y;  o[14] = z; o[15] = 1;
    return o;
  },

  // Build a view matrix from eye position + yaw/pitch (radians), using an
  // explicit right/up/forward basis (lookAt style). Camera looks down -Z.
  fromYawPitch(o, eye, yaw, pitch) {
    const f = lookDir(yaw, pitch);           // forward (look) direction
    // right = normalize(cross(forward, worldUp=[0,1,0])) = normalize([-f.z, 0, f.x])
    let rx = -f[2], ry = 0, rz = f[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    // up = cross(right, forward)
    const ux = ry * f[2] - rz * f[1];
    const uy = rz * f[0] - rx * f[2];
    const uz = rx * f[1] - ry * f[0];

    o[0] = rx; o[1] = ux; o[2]  = -f[0]; o[3]  = 0;
    o[4] = ry; o[5] = uy; o[6]  = -f[1]; o[7]  = 0;
    o[8] = rz; o[9] = uz; o[10] = -f[2]; o[11] = 0;
    o[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
    o[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    o[14] =  (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]);
    o[15] = 1;
    return o;
  },
};

// Direction the camera looks for a given yaw/pitch. yaw=0 looks toward -Z.
export function lookDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [
    -Math.sin(yaw) * cp,
    Math.sin(pitch),
    -Math.cos(yaw) * cp,
  ];
}

// Extract 6 frustum planes from a combined proj*view matrix (for chunk culling).
// Each plane is [a,b,c,d] with a*x+b*y+c*z+d >= 0 meaning "inside".
export function frustumPlanes(m) {
  const planes = [];
  // rows of the matrix
  const r0=[m[0],m[4],m[8],m[12]];
  const r1=[m[1],m[5],m[9],m[13]];
  const r2=[m[2],m[6],m[10],m[14]];
  const r3=[m[3],m[7],m[11],m[15]];
  const add = (a, b, sign) => {
    const p = [a[0]+sign*b[0], a[1]+sign*b[1], a[2]+sign*b[2], a[3]+sign*b[3]];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    p[0]/=len; p[1]/=len; p[2]/=len; p[3]/=len;
    planes.push(p);
  };
  add(r3, r0, +1); // left
  add(r3, r0, -1); // right
  add(r3, r1, +1); // bottom
  add(r3, r1, -1); // top
  add(r3, r2, +1); // near
  add(r3, r2, -1); // far
  return planes;
}

// Is an axis-aligned box (min,max) at least partially inside the frustum?
export function aabbInFrustum(planes, minx, miny, minz, maxx, maxy, maxz) {
  for (const p of planes) {
    // pick the corner most in the direction of the plane normal
    const x = p[0] >= 0 ? maxx : minx;
    const y = p[1] >= 0 ? maxy : miny;
    const z = p[2] >= 0 ? maxz : minz;
    if (p[0]*x + p[1]*y + p[2]*z + p[3] < 0) return false;
  }
  return true;
}
