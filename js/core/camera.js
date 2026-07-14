// View/projection camera. Holds the matrices and exposes frustum planes so the
// renderer can cull chunks that are off-screen.

import { mat4, lookDir, frustumPlanes } from "./mat4.js";

export class Camera {
  constructor() {
    this.proj = mat4.create();
    this.view = mat4.create();
    this.viewProj = mat4.create();
    this.pos = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 70;
    this.near = 0.1;
    // Far is deliberately modest: the deferred pass reconstructs world position
    // from the depth buffer, and a huge far plane crushes perspective-depth
    // precision near 1.0 (float32 reconstruction then loses several blocks in the
    // near field, which broke shadow/fog lookups). 512 covers max render distance.
    this.far = 512;
    this.planes = [];
  }

  setProjection(aspect, fovDeg) {
    this.fov = fovDeg;
    mat4.perspective(this.proj, (fovDeg * Math.PI) / 180, aspect, this.near, this.far);
  }

  // eye = world position of the camera (player eye)
  update(eye, yaw, pitch) {
    this.pos = eye;
    this.yaw = yaw;
    this.pitch = pitch;
    mat4.fromYawPitch(this.view, eye, yaw, pitch);
    mat4.multiply(this.viewProj, this.proj, this.view);
    this.planes = frustumPlanes(this.viewProj);
  }

  // Point the camera along an explicit direction with an explicit up vector (a
  // full lookAt), rather than yaw/pitch. Used to render the six 90°-FOV cube
  // faces of a panorama capture, where the ±Y faces need a non-world up vector.
  setLook(eye, dir, up, fovDeg, aspect) {
    this.pos = eye;
    this.fov = fovDeg;
    mat4.perspective(this.proj, (fovDeg * Math.PI) / 180, aspect, this.near, this.far);
    const target = [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]];
    mat4.lookAt(this.view, eye, target, up);
    mat4.multiply(this.viewProj, this.proj, this.view);
    this.planes = frustumPlanes(this.viewProj);
  }

  forward() { return lookDir(this.yaw, this.pitch); }
}
