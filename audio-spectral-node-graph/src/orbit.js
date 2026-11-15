// The camera only ever turns around the box. It never pans and never zooms
// by hand: its distance comes from the box, so the whole box stays in view
// from every angle.

const FOV = Math.PI / 3; // vertical field of view
const MARGIN = 0.82; // the box may fill this much of the screen
const NODE_SCALE = 0.42; // how big nodes are next to the box

export class Orbit {
  constructor() {
    this.reset();
  }

  reset() {
    this.yaw = 0;
    this.pitch = 0.28;
    this.spin = { yaw: 0, pitch: 0 };
    this.auto = true;
    this.distance = null;
    this.center = null;
  }

  drag(dx, dy) {
    this.spin.yaw = dx * 0.006;
    this.spin.pitch = dy * 0.006;
  }

  toggle() {
    this.auto = !this.auto;
  }

  update(dt, min, max, viewWidth, viewHeight) {
    if (this.auto) this.spin.yaw += (0.0055 - this.spin.yaw) * 0.04;
    else this.spin.yaw *= 0.92;
    this.spin.pitch *= 0.92;

    this.yaw += this.spin.yaw;
    this.pitch = Math.min(1.2, Math.max(-1.2, this.pitch + this.spin.pitch));

    const center = min.map((v, i) => (v + max[i]) / 2);
    this.focal = viewHeight / 2 / Math.tan(FOV / 2);
    const target = this.fit(min, max, center, viewWidth, viewHeight);

    if (this.distance === null) {
      this.distance = target;
      this.center = [...center];
    }
    // back away as fast as the box grows, come closer slowly
    const out = 1 - Math.exp(-10 * dt);
    const back = 1 - Math.exp(-1.2 * dt);
    this.distance += (target - this.distance) * (target > this.distance ? out : back);
    const follow = 1 - Math.exp(-5 * dt);
    this.center = this.center.map((c, i) => c + (center[i] - c) * follow);
  }

  // The closest distance at which all eight corners of the box land inside
  // the screen, seen from the current angle.
  fit(min, max, center, viewWidth, viewHeight) {
    const roomX = (viewWidth / 2) * MARGIN;
    const roomY = (viewHeight / 2) * MARGIN;
    let distance = 0;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) {
          const [px, py, pz] = this.turn([x, y, z], center);
          // a corner fits when |px| * focal / (distance + pz) <= room
          distance = Math.max(
            distance,
            (Math.abs(px) * this.focal) / roomX - pz,
            (Math.abs(py) * this.focal) / roomY - pz,
          );
        }
    return Math.max(distance, 50);
  }

  turn([x, y, z], [cx, cy, cz]) {
    let px = x - cx;
    let py = y - cy;
    let pz = z - cz;
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    [px, pz] = [px * cosY - pz * sinY, px * sinY + pz * cosY];
    const cosX = Math.cos(this.pitch);
    const sinX = Math.sin(this.pitch);
    [py, pz] = [py * cosX - pz * sinX, py * sinX + pz * cosX];
    return [px, py, pz];
  }

  // World point to screen. Nodes are drawn in pixels, so `sc` scales them
  // with the view: smaller when the box is big, bigger when it is small.
  project(point, viewWidth, viewHeight) {
    const [px, py, pz] = this.turn(point, this.center);
    const depth = Math.max(pz + this.distance, this.distance * 0.05);
    const scale = this.focal / depth;
    return {
      sx: viewWidth / 2 + px * scale,
      sy: viewHeight / 2 + py * scale,
      sc: Math.min(1, Math.max(0.15, scale * NODE_SCALE)),
      depth: pz,
    };
  }
}
