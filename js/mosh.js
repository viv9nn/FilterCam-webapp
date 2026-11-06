// WebGL2 port of MoshRenderer.swift + Mosh.metal.
//
// A datamosh effect built the same way video codecs work: estimate block motion
// between frames, then move the *previous moshed image* along that motion instead
// of showing the clean new frame.
//
// Every internal texture stores row 0 = top of the image, so the passes can use
// texelFetch(gl_FragCoord) directly. Only the on-screen pass flips Y.

// Longest side of the frames we process. Keeps phones smooth.
const MAX_PROCESS_SIZE = 1280;

const SHARED = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 outColor;
// Size of each "macroblock" in pixels. Bigger = chunkier mosh.
const int kBlockSize = 16;
// How far (in pixels) to search for where a block moved, and the search step.
const int kSearchRadius = 24;
const int kSearchStep = 4;
// How strongly motion drags the moshed pixels (1 = follows real motion).
const float kMotionAmplify = 1.5;
// How much of the real frame's change leaks in each frame. Lower = more mosh.
const float kResidualAmount = 0.35;
// How fast still blocks heal back to the live image each frame.
const float kHealRate = 0.08;

float luma(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)); }
`;

const VERTEX = /* glsl */ `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0); }
`;

// Copies the camera frame into a working texture: scaled down and mirrored.
const INGEST = SHARED + /* glsl */ `
uniform sampler2D uVideo;
uniform vec2 uSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  uv.x = 1.0 - uv.x;
  outColor = vec4(texture(uVideo, uv).rgb, 1.0);
}
`;

// One fragment per block: find the offset into the previous frame that best matches
// this block in the current frame (sum of absolute differences on a sparse grid).
// Offsets are stored as (offset + 128) / 255 so an RGBA8 texture holds them exactly.
const ESTIMATE_MOTION = SHARED + /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uPrevious;
void main() {
  ivec2 size = textureSize(uCurrent, 0);
  ivec2 origin = ivec2(gl_FragCoord.xy) * kBlockSize;

  // The block's own samples don't change during the search, so read them once.
  float here[16];
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      ivec2 p = clamp(origin + ivec2(x, y) * 4, ivec2(0), size - 1);
      here[y * 4 + x] = luma(texelFetch(uCurrent, p, 0));
    }
  }

  float bestScore = 1e20;
  ivec2 bestOffset = ivec2(0);
  for (int dy = -kSearchRadius; dy <= kSearchRadius; dy += kSearchStep) {
    for (int dx = -kSearchRadius; dx <= kSearchRadius; dx += kSearchStep) {
      float score = 0.0;
      for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 4; x++) {
          ivec2 p = clamp(origin + ivec2(x, y) * 4, ivec2(0), size - 1);
          ivec2 q = clamp(p + ivec2(dx, dy), ivec2(0), size - 1);
          score += abs(here[y * 4 + x] - luma(texelFetch(uPrevious, q, 0)));
        }
      }
      // Small bias toward "no motion" so still areas don't jitter.
      score += 0.01 * length(vec2(dx, dy));
      if (score < bestScore) {
        bestScore = score;
        bestOffset = ivec2(dx, dy);
      }
    }
  }
  outColor = vec4((vec2(bestOffset) + 128.0) / 255.0, 0.0, 1.0);
}
`;

// Builds the next moshed frame: drag the old moshed pixels along each block's motion,
// add a little of the real change, and let still blocks heal toward the live image.
const MOSH = SHARED + /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uPrevious;
uniform sampler2D uMoshIn;
uniform sampler2D uMotion;
uniform float uForceRefresh;
void main() {
  ivec2 size = textureSize(uCurrent, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);

  ivec2 maxBlock = textureSize(uMotion, 0) - 1;
  ivec2 block = min(p / kBlockSize, maxBlock);
  vec2 mv = round(texelFetch(uMotion, block, 0).xy * 255.0) - 128.0;

  ivec2 realSource = clamp(p + ivec2(mv), ivec2(0), size - 1);
  ivec2 moshSource = clamp(p + ivec2(mv * kMotionAmplify), ivec2(0), size - 1);

  vec4 live = texelFetch(uCurrent, p, 0);
  vec4 residual = live - texelFetch(uPrevious, realSource, 0);
  vec4 moshed = texelFetch(uMoshIn, moshSource, 0) + residual * kResidualAmount;

  float heal = kHealRate * (1.0 - clamp(length(mv) / 4.0, 0.0, 1.0));
  vec4 result = mix(moshed, live, max(heal, uForceRefresh));
  outColor = vec4(clamp(result.rgb, 0.0, 1.0), 1.0);
}
`;

// Draws the moshed image onto the screen, aspect-filling like the camera preview.
const PRESENT = SHARED + /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uOutSize;
void main() {
  vec2 srcSize = vec2(textureSize(uSource, 0));
  vec2 frag = vec2(gl_FragCoord.x, uOutSize.y - gl_FragCoord.y);
  float scale = max(uOutSize.x / srcSize.x, uOutSize.y / srcSize.y);
  vec2 uv = ((frag - uOutSize * 0.5) / scale + srcSize * 0.5) / srcSize;
  outColor = vec4(texture(uSource, uv).rgb, 1.0);
}
`;

// Straight copy, used to read the mosh back as 8-bit pixels for a photo.
const COPY = SHARED + /* glsl */ `
uniform sampler2D uSource;
void main() { outColor = texelFetch(uSource, ivec2(gl_FragCoord.xy), 0); }
`;

export class MoshRenderer {
  /**
   * @param {HTMLCanvasElement} canvas  on-screen canvas the mosh is drawn into
   * @param {HTMLVideoElement} video    live camera feed
   */
  constructor(canvas, video) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.video = video;
    this.running = false;
    this.needsRefresh = true;
    this.width = 0;
    this.height = 0;

    // Half-float so slow healing doesn't get stuck on 8-bit rounding (when supported).
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');

    this.programs = {
      ingest: this.#program(INGEST),
      motion: this.#program(ESTIMATE_MOTION),
      mosh: this.#program(MOSH),
      present: this.#program(PRESENT),
      copy: this.#program(COPY),
    };
    this.vao = gl.createVertexArray();
    this.videoTexture = this.#videoTexture();
  }

  /** Wipes the mosh so the next frame starts clean. */
  reset() {
    this.needsRefresh = true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.reset();
    this.#scheduleFrame();
  }

  stop() {
    this.running = false;
  }

  /** The current moshed image as a canvas, or null if nothing has been drawn yet. */
  snapshot() {
    if (!this.hasFrame) return null;
    const { gl, width, height } = this;
    const target = this.#target(gl.RGBA8, width, height, gl.NEAREST);
    this.#draw(this.programs.copy, target, width, height, { uSource: this.mosh[0].texture });
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.texture);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas;
  }

  #scheduleFrame() {
    if (!this.running) return;
    // Only process real new camera frames, like the AVCapture delegate did.
    if ('requestVideoFrameCallback' in this.video) {
      this.video.requestVideoFrameCallback(() => this.#frame());
    } else {
      requestAnimationFrame(() => this.#frame());
    }
  }

  #frame() {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.video.videoWidth) {
      this.#process();
    }
    this.#scheduleFrame();
  }

  #process() {
    const { gl, video } = this;
    const scale = Math.min(1, MAX_PROCESS_SIZE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (width !== this.width || height !== this.height) this.#allocate(width, height);

    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);

    // frames[0] = current, frames[1] = previous; mosh[1] = last mosh, mosh[0] = new mosh.
    [this.frames[0], this.frames[1]] = [this.frames[1], this.frames[0]];
    [this.mosh[0], this.mosh[1]] = [this.mosh[1], this.mosh[0]];
    const [current, previous] = this.frames;
    const [moshOut, moshIn] = this.mosh;

    this.#draw(this.programs.ingest, current, width, height, {
      uVideo: this.videoTexture,
      uSize: [width, height],
    });
    this.#draw(this.programs.motion, this.motionField, this.blocksWide, this.blocksHigh, {
      uCurrent: current.texture,
      uPrevious: previous.texture,
    });
    this.#draw(this.programs.mosh, moshOut, width, height, {
      uCurrent: current.texture,
      uPrevious: previous.texture,
      uMoshIn: moshIn.texture,
      uMotion: this.motionField.texture,
      uForceRefresh: this.needsRefresh ? 1 : 0,
    });
    this.needsRefresh = false;
    this.hasFrame = true;

    this.#resizeCanvas();
    this.#draw(this.programs.present, null, this.canvas.width, this.canvas.height, {
      uSource: moshOut.texture,
      uOutSize: [this.canvas.width, this.canvas.height],
    });
  }

  #resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  #allocate(width, height) {
    const { gl } = this;
    for (const t of [...(this.frames ?? []), ...(this.mosh ?? []), this.motionField].filter(Boolean)) {
      gl.deleteFramebuffer(t.framebuffer);
      gl.deleteTexture(t.texture);
    }
    const moshFormat = this.floatTargets ? gl.RGBA16F : gl.RGBA8;
    this.width = width;
    this.height = height;
    this.blocksWide = Math.ceil(width / 16);
    this.blocksHigh = Math.ceil(height / 16);
    this.frames = [this.#target(gl.RGBA8, width, height), this.#target(gl.RGBA8, width, height)];
    this.mosh = [
      this.#target(moshFormat, width, height, gl.LINEAR),
      this.#target(moshFormat, width, height, gl.LINEAR),
    ];
    this.motionField = this.#target(gl.RGBA8, this.blocksWide, this.blocksHigh);
    this.hasFrame = false;
    this.needsRefresh = true;
  }

  // ---------- WebGL plumbing ----------

  #program(fragmentSource) {
    const { gl } = this;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    return { program, locations: new Map() };
  }

  #texture(internalFormat, width, height, filter = this.gl.NEAREST) {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Mutable texture, since the camera frame is re-uploaded (and may change size) every frame. */
  #videoTexture() {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  #target(internalFormat, width, height, filter) {
    const { gl } = this;
    const texture = this.#texture(internalFormat, width, height, filter);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer };
  }

  #draw({ program, locations }, target, width, height, uniforms) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    let unit = 0;
    for (const [name, value] of Object.entries(uniforms)) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      const location = locations.get(name);
      if (value instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(location, unit++);
      } else if (Array.isArray(value)) {
        gl.uniform2f(location, value[0], value[1]);
      } else {
        gl.uniform1f(location, value);
      }
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
