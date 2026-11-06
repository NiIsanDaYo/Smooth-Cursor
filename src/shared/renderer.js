'use strict';
// WebGL2 motion-blur renderer. One full-canvas pass: every pixel averages the sprite sampled
// at all shutter positions in float precision, then writes premultiplied RGBA once.
// (Canvas2D 'lighter' with globalAlpha = 1/N rounds to 8 bits on every copy and bands.)
//
// The canvas is only as large as the blurred cursor and is moved with a transform, so the
// compositor redraws a small rectangle per frame instead of the whole viewport.
(function (SC) {
  const MAX = 256;
  const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) * 2 - 1), float((gl_VertexID >> 1) * 2 - 1));
  gl_Position = vec4(p, 0.0, 1.0);
}`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D uSprite;
uniform vec2 uSpriteSize;
uniform float uCanvasH;
uniform int uCount;
uniform vec4 uPos[${MAX / 2}];
out vec4 outColor;
void main() {
  vec2 frag = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uCount) break;
    vec4 pp = uPos[i >> 1];
    vec2 o = (i & 1) == 0 ? pp.xy : pp.zw;
    vec2 uv = (frag - o) / uSpriteSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    acc += texture(uSprite, uv);
  }
  outColor = acc / float(uCount);
}`;
  const BUCKET = 64;

  class Renderer {
    // container: element the canvas is placed in (position: relative/fixed context).
    constructor(container, { onFatal, onLost } = {}) {
      this.container = container;
      this.onFatal = onFatal || (() => {});
      this.onLost = onLost || (() => {});
      this.canvas = document.createElement('canvas');
      const s = this.canvas.style;
      s.position = 'absolute';
      s.left = '0';
      s.top = '0';
      s.transformOrigin = '0 0';
      s.pointerEvents = 'none';
      s.visibility = 'hidden';
      s.willChange = 'transform';
      container.appendChild(this.canvas);
      this.uPos = new Float32Array(MAX * 2);
      this.sprite = null;          // { key, w, h, hx, hy }
      this.shrinkFrames = 0;
      this.visible = false;
      this.lost = false;
      this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.gl = null; this.sprite = null; this.onLost(); }, false);
      this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this._init(); }, false);
      this._init();
    }

    get ok() { return !!this.gl; }

    _init() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false,
        // Keeps hybrid-GPU laptops on the integrated GPU; the workload is tiny.
        powerPreference: 'low-power',
      });
      if (!gl) { this.gl = null; this.onFatal('webgl2'); return; }
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        this.loc = {
          sprite: gl.getUniformLocation(prog, 'uSprite'),
          size: gl.getUniformLocation(prog, 'uSpriteSize'),
          h: gl.getUniformLocation(prog, 'uCanvasH'),
          count: gl.getUniformLocation(prog, 'uCount'),
          pos: gl.getUniformLocation(prog, 'uPos'),
        };
        gl.bindVertexArray(gl.createVertexArray());
        this.tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.uniform1i(this.loc.sprite, 0);
        gl.disable(gl.BLEND);
        this.gl = gl;
      } catch (err) {
        this.gl = null;
        this.onFatal('shader', err);
      }
    }

    // sprite: { key, canvas, hx, hy } in device px; hx/hy = hotspot inside the canvas.
    setSprite(sprite) {
      const gl = this.gl;
      if (!gl || !sprite) return;
      if (this.sprite && this.sprite.key === sprite.key && !sprite.dynamic) return;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sprite.canvas);
      this.sprite = { key: sprite.key, w: sprite.canvas.width, h: sprite.canvas.height, hx: sprite.hx, hy: sprite.hy };
    }

    hide() {
      if (!this.visible) return;
      this.visible = false;
      this.canvas.style.visibility = 'hidden';
    }

    // positions: device px (hotspot locations); offX/offY: device px of the container origin
    // in the same space, subtracted so the canvas lands where the positions say.
    // dpr: device px per CSS px of the container (for sizing the canvas element).
    draw(positions, count, dpr, offX = 0, offY = 0) {
      const gl = this.gl, sp = this.sprite;
      if (!gl || !sp || count < 1) { this.hide(); return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        const x = positions[2 * i] - offX - sp.hx, y = positions[2 * i + 1] - offY - sp.hy;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const ox = Math.floor(minX) - 1, oy = Math.floor(minY) - 1;
      const needW = Math.ceil(maxX + sp.w) + 1 - ox, needH = Math.ceil(maxY + sp.h) + 1 - oy;
      const c = this.canvas;
      const bw = Math.ceil(needW / BUCKET) * BUCKET, bh = Math.ceil(needH / BUCKET) * BUCKET;
      if (c.width < needW || c.height < needH) {
        c.width = Math.max(bw, c.width < needW ? bw : c.width);
        c.height = Math.max(bh, c.height < needH ? bh : c.height);
        this.shrinkFrames = 0;
      } else if (c.width > 2 * bw || c.height > 2 * bh) {
        // Shrink only after a second of smaller needs to avoid reallocating on every flick.
        if (++this.shrinkFrames > 60) { c.width = bw; c.height = bh; this.shrinkFrames = 0; }
      } else {
        this.shrinkFrames = 0;
      }
      const W = c.width, H = c.height;
      if (this._cssW !== W || this._cssH !== H || this._dpr !== dpr) {
        c.style.width = W / dpr + 'px';
        c.style.height = H / dpr + 'px';
        this._cssW = W; this._cssH = H; this._dpr = dpr;
      }
      c.style.transform = `translate(${ox / dpr}px, ${oy / dpr}px)`;

      const u = this.uPos;
      for (let i = 0; i < count; i++) {
        u[2 * i] = positions[2 * i] - offX - sp.hx - ox;
        u[2 * i + 1] = positions[2 * i + 1] - offY - sp.hy - oy;
      }
      gl.viewport(0, 0, W, H);
      gl.uniform2f(this.loc.size, sp.w, sp.h);
      gl.uniform1f(this.loc.h, H);
      gl.uniform1i(this.loc.count, count);
      gl.uniform4fv(this.loc.pos, u, 0, Math.ceil(count / 2) * 4);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!this.visible) {
        this.visible = true;
        c.style.visibility = 'visible';
      }
    }

    destroy() {
      const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      this.gl = null;
      this.canvas.remove();
    }
  }

  SC.Renderer = Renderer;
})(self.SmoothCursor);
