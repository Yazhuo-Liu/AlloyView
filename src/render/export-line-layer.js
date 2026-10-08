// WebGL implementations usually clamp native GL_LINES to one pixel. For a
// larger image, render annotation edges as screen-space ribbons so cell and
// slice outlines grow with the image, including across export tile boundaries.
const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aFirst;
layout(location=1) in vec3 aLast;
uniform mat4 uViewProjection;
uniform vec2 uViewport;
uniform float uWidth;
void main() {
  vec4 first = uViewProjection * vec4(aFirst, 1.0);
  vec4 last = uViewProjection * vec4(aLast, 1.0);
  float firstNear = first.z + first.w, lastNear = last.z + last.w;
  if (firstNear < 0.0 && lastNear < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (firstNear < 0.0) first = mix(first, last, firstNear / (firstNear - lastNear));
  else if (lastNear < 0.0) last = mix(last, first, lastNear / (lastNear - firstNear));
  vec2 direction = (last.xy / last.w - first.xy / first.w) * uViewport;
  float lengthSquared = dot(direction, direction);
  if (lengthSquared < 1e-12) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 normal = vec2(-direction.y, direction.x) * inversesqrt(lengthSquared);
  vec4 clip = gl_VertexID < 2 ? first : last;
  // Counterclockwise strips remain visible with the renderer's back-face
  // culling enabled (also restored after drawing Voronoi faces).
  float side = gl_VertexID % 2 == 0 ? 1.0 : -1.0;
  clip.xy += side * normal * uWidth / uViewport * clip.w;
  gl_Position = clip;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor, 0.92); }`;

export class ExportLineLayer {
  constructor(gl) {
    this.gl = gl;
    const shaders = [], program = gl.createProgram();
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
        const shader = gl.createShader(type); shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Unable to create export edge shader.');
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Unable to create export edge program.');
      this.program = program; this.vao = gl.createVertexArray();
      this.uniforms = Object.fromEntries(['uViewProjection', 'uViewport', 'uWidth', 'uColor'].map(name => [name, gl.getUniformLocation(program, name)]));
      gl.bindVertexArray(this.vao);
      for (const location of [0, 1]) { gl.enableVertexAttribArray(location); gl.vertexAttribDivisor(location, 1); }
      gl.bindVertexArray(null);
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }
  draw(renderer, buffer, first, count, color) {
    const gl = this.gl, u = this.uniforms, viewport = renderer.renderViewport;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, first * 12);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, first * 12 + 12);
    gl.uniformMatrix4fv(u.uViewProjection, false, renderer.viewProjectionMatrix);
    gl.uniform2f(u.uViewport, viewport.tile.renderWidth, viewport.tile.renderHeight);
    gl.uniform1f(u.uWidth, viewport.lineScale); gl.uniform3f(u.uColor, ...color);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count / 2);
  }
}
