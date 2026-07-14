// WebGL2 context creation and shader/program/buffer helpers.

export function createGL(canvas) {
  const gl = canvas.getContext("webgl2", {
    // MSAA off: the scene renders into non-multisampled FBOs and reaches the
    // default framebuffer as one fullscreen textured triangle, so a multisampled
    // backbuffer antialiases nothing — it only costs a resolve every frame.
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) {
    throw new Error("WebGL2 is not available in this browser.");
  }
  return gl;
}

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader compile error:\n" + log + "\n--- source ---\n" + source);
  }
  return sh;
}

// Create a program from vertex+fragment source. attribs is an array of names so
// we can bind stable attribute locations (0..n) before linking.
export function createProgram(gl, vsSource, fsSource, attribs = []) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  attribs.forEach((name, i) => gl.bindAttribLocation(prog, i, name));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("Program link error:\n" + gl.getProgramInfoLog(prog));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // Cache uniform locations lazily.
  const uniformCache = {};
  prog.uniform = (name) => {
    if (!(name in uniformCache)) uniformCache[name] = gl.getUniformLocation(prog, name);
    return uniformCache[name];
  };
  return prog;
}

// Upload a canvas as a 2D texture with crisp (nearest) pixel-art filtering.
export function createTextureFromCanvas(gl, canvas) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
