import { AudioPlayer } from './audio.js';
import { buildUI } from './ui.js';
import CONFIG from './config.js';
import { AdaptiveAnalysis, normalizedSpectrum } from './adaptive.js';
import { Orbit } from './orbit.js';
import { isHighlighted, nodeRenderOrder } from './rendering.js';
import {
  bandEnergy,
  melEnergies,
  spectralCentroid,
  spectralSpread,
  spectralTilt,
} from './spectral.js';

// ═══════════════════════════════════════════════════════════════
// SPATIO-TEMPORAL SPECTRAL NODE GRAPH
// ═══════════════════════════════════════════════════════════════
//
// Nodes live in a 3D world. A box follows them: it grows the moment
// the sound spreads out and shrinks back when it settles. The camera
// only turns around the centre of that box, at a distance that keeps
// the whole box in view, so the graph is always on screen.

// ─────────────────────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────────────────────

const state = {
  fft: null,
  amp: null,
  analysis: new AdaptiveAnalysis(),
  analysisElapsed: 0,
  features: { active: false, level: 0 },

  liveSpectrum: null,
  liveCentroid: 0,
  liveSpread: 0,
  liveRMS: 0,
  liveFlux: 0,

  nodes: [],
  framesSinceSpawn: 0,
  currentBurst: 0,
  unclutterSlots: new Map(),

  bounds: {
    centroid: { min: 0.3, max: 0.7 },
    spread: { min: 0.1, max: 0.4 },
    tilt: { min: 0.3, max: 0.7 },
  },

  box: { min: null, max: null },
  bass: { pulse: 0, base: 0, shockPulse: 0, rmsSmooth: 0 },
  drag: { active: false, travel: 0 },
  stars: [],
  music: { melodyDrive: 0, boom: 0, prevCentroid: 0 },
};

const orbit = new Orbit();

// ═══════════════════════════════════════════════════════════════
// MAIN LIFECYCLE
// ═══════════════════════════════════════════════════════════════

let player;
let ui;

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('visualizer');
  canvas.elt.setAttribute(
    'aria-label',
    'Animated spectral graph of your audio',
  );
  colorMode(HSB, 360, 100, 100, 100);
  textFont('monospace');
  state.fft = new p5.FFT(0.85, CONFIG.audio.fftBins);
  state.amp = new p5.Amplitude();
  initStars();
  player = new AudioPlayer({
    fft: state.fft,
    amplitude: state.amp,
    onChange: () => ui?.update(),
    onReset: resetAudioState,
  });
  ui = buildUI({ player, clear: resetAudioState, toggleFullscreen });
  ui.update();
}

function initStars() {
  for (let i = 0; i < CONFIG.display.starCount; i++) {
    state.stars.push({
      x: random(width),
      y: random(height),
      r: random(0.5, 2.0),
    });
  }
}

// ──────────────────────────────────────────────────────────
// DRAW LOOP
// ──────────────────────────────────────────────────────────

function draw() {
  const bgAlpha = map(constrain(state.bass.pulse, 0, 1.2), 0, 1.2, 88, 68);
  background(0, 0, 2, bgAlpha);
  const dt = Math.min(deltaTime / 1000, 0.08);

  drawStars();
  drawFreqBar();

  if (player.isLoaded && player.isPlaying) {
    processAudio();
  } else {
    relaxImmersion();
  }

  updateNodeBounds();
  const world = worldPositions();
  updateBox(world, dt);
  orbit.update(dt, state.box.min, state.box.max, width, height);

  const projections = world.map((p) => orbit.project(p, width, height));
  applyUnclutterOffsets(projections);
  const renderOrder = calculateRenderOrder(projections);
  drawEdges3D(projections);
  drawBox();
  drawAxisCross();
  drawNodes3D(renderOrder, projections);
  drawOrbitHint();
  drawReadoutPanel();
  drawVignette();

  applyRepulsion();
  updateNodeLifecycle();
}

function relaxImmersion() {
  state.bass.pulse = lerp(state.bass.pulse, 0, 0.06);
  state.bass.shockPulse = lerp(state.bass.shockPulse, 0, 0.08);
}

function updateNodeLifecycle() {
  state.nodes = state.nodes.filter((n) => {
    n.age += Math.min(deltaTime / 1000, 0.08) * 60;
    applyNodeFlowDrift(n);
    n.dx += n.vx;
    n.dy += n.vy;
    return n.age < CONFIG.nodes.fadeFrames + 20;
  });
}

// ═══════════════════════════════════════════════════════════════
// THE BOX
// ═══════════════════════════════════════════════════════════════

// Grow fast so nothing pokes out for long, shrink slowly so it breathes.
function updateBox(world, dt) {
  const pad = CONFIG.box.pad;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  world.forEach((p, i) => {
    const life = 1 - state.nodes[i].age / CONFIG.nodes.fadeFrames;
    if (life < 0.35) return; // fading, let the box let go
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k] - pad);
      hi[k] = Math.max(hi[k], p[k] + pad);
    }
  });
  const { box } = state;
  if (lo[0] === Infinity) {
    if (box.min === null) {
      box.min = [-CONFIG.box.rest, -CONFIG.box.rest, -CONFIG.box.rest];
      box.max = [CONFIG.box.rest, CONFIG.box.rest, CONFIG.box.rest];
    }
    return;
  }
  if (box.min === null) {
    box.min = lo;
    box.max = hi;
    return;
  }
  const grow = 1 - Math.exp(-CONFIG.box.growRate * dt);
  const shrink = 1 - Math.exp(-CONFIG.box.shrinkRate * dt);
  for (let k = 0; k < 3; k++) {
    box.min[k] = lerp(box.min[k], lo[k], lo[k] < box.min[k] ? grow : shrink);
    box.max[k] = lerp(box.max[k], hi[k], hi[k] > box.max[k] ? grow : shrink);
  }
}

function boxCenter() {
  return state.box.min.map((v, k) => (v + state.box.max[k]) / 2);
}

function boxSize() {
  return state.box.min.map((v, k) => state.box.max[k] - v);
}

function drawBox() {
  const { min: a, max: b } = state.box;
  const corners = [];
  for (const x of [a[0], b[0]])
    for (const y of [a[1], b[1]])
      for (const z of [a[2], b[2]]) corners.push(orbit.project([x, y, z], width, height));

  // corners differ in one coordinate along an edge: indices 1, 2 and 4 apart
  const edges = [];
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4]) if (!(i & bit)) edges.push([i, i | bit]);

  noFill();
  for (const [i, j] of edges) {
    const p = corners[i];
    const q = corners[j];
    // the faint edge, then a brighter bracket at each end
    stroke(0, 0, 40, 18);
    strokeWeight(0.6);
    line(p.sx, p.sy, q.sx, q.sy);
    const t = min(0.15, 30 / max(1, dist(p.sx, p.sy, q.sx, q.sy)));
    stroke(0, 0, 60, 48);
    line(p.sx, p.sy, lerp(p.sx, q.sx, t), lerp(p.sy, q.sy, t));
    line(q.sx, q.sy, lerp(q.sx, p.sx, t), lerp(q.sy, p.sy, t));
  }
}

// ═══════════════════════════════════════════════════════════════
// FLOW & UNCLUTTER
// ═══════════════════════════════════════════════════════════════

function applyNebulaWarp(nx, ny, node) {
  const t = frameCount * 0.0035;
  const pulse = constrain(state.bass.pulse, 0, 1.2);
  const melodyBoost = state.music.melodyDrive * CONFIG.magic.melodyWarpBoost;
  const warp =
    CONFIG.composition.warpAmount +
    pulse * CONFIG.composition.warpBreath +
    melodyBoost;
  const n1 = noise(node.seedA + t, node.seedB * 0.5 + t * 0.7) - 0.5;
  const n2 = noise(node.seedB + t * 0.8, node.seedA * 0.4 + t) - 0.5;
  const size = CONFIG.world.size;
  return { x: nx + n1 * size * warp, y: ny + n2 * size * warp * 0.82 };
}

function applyNodeFlowDrift(node) {
  const cfg = CONFIG.flow;
  const t = frameCount * cfg.driftNoiseSpeed;
  const melodyBoost =
    1 + state.music.melodyDrive * CONFIG.magic.melodyDriftBoost;
  const burstBoost =
    node.burstId === state.currentBurst
      ? cfg.driftBurstBoost * melodyBoost
      : melodyBoost;
  const nx = noise(node.seedA + t, node.seedB + t * 0.6) - 0.5;
  const ny = noise(node.seedB + t * 0.9, node.seedA + t * 0.4) - 0.5;
  node.vx += nx * cfg.driftAccel * burstBoost;
  node.vy += ny * cfg.driftAccel * burstBoost;
  node.vx *= cfg.driftDamping;
  node.vy *= cfg.driftDamping;
  node.vx = constrain(node.vx, -cfg.driftMaxVel, cfg.driftMaxVel);
  node.vy = constrain(node.vy, -cfg.driftMaxVel, cfg.driftMaxVel);
  if (node.burstId === state.currentBurst && state.music.boom > 0.01) {
    const ox = node.dx,
      oy = node.dy;
    const d = max(1, sqrt(ox * ox + oy * oy));
    const boomPush = state.music.boom * CONFIG.magic.boomOutwardForce;
    node.vx += (ox / d) * boomPush;
    node.vy += (oy / d) * boomPush;
  }
}

function applyUnclutterOffsets(proj) {
  const { nodes, currentBurst } = state;
  const cfg = CONFIG.spectral;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.burstId !== currentBurst) continue;
    const slot = n.unclutterSlot || 0;
    const seed = n.unclutterSeed || 0;
    const radius =
      min(cfg.unclutterMaxPx, sqrt(slot) * cfg.unclutterStepPx) *
      cfg.unclutterStrength;
    if (radius <= 0) continue;
    const angle = slot * 2.39996323 + seed;
    proj[i].sx += cos(angle) * radius;
    proj[i].sy += sin(angle) * radius * 0.88;
  }
}

// ═══════════════════════════════════════════════════════════════
// AUDIO ANALYSIS & NODE SPAWNING
// ═══════════════════════════════════════════════════════════════

function processAudio() {
  const dt = Math.min(deltaTime / 1000, 0.08);
  state.analysisElapsed += dt;
  const rms = state.amp.getLevel();
  if (state.analysisElapsed >= 0.05) {
    const adaptiveSpectrum = normalizedSpectrum(state.fft.analyze('dB'));
    const spectrum = state.fft.analyze();
    state.features = state.analysis.update({
      spectrum: adaptiveSpectrum,
      rms,
      sampleRate: getAudioContext().sampleRate,
      dt: state.analysisElapsed,
    });
    state.analysisElapsed = 0;
    // Preserve the original spectrum mapping, with a fallback below its floor.
    state.liveSpectrum = spectrum.some((value) => value > 0)
      ? spectrum
      : adaptiveSpectrum;
    state.liveCentroid = spectralCentroid(state.liveSpectrum);
    state.liveSpread = spectralSpread(state.liveSpectrum, state.liveCentroid);
    state.liveFlux = state.features.flux || 0;
    if (state.features.onset) state.currentBurst++;
  }
  state.liveRMS = rms;
  if (!state.liveSpectrum) return;
  // Keep the original RMS response, with a visual floor for quiet recordings.
  const visualRMS = Math.max(rms, state.features.level * 0.08);
  updateImmersionState(state.liveSpectrum, visualRMS, state.liveCentroid);
  spawnNodesFromAudio(state.liveSpectrum, state.liveCentroid, visualRMS);
}

function spawnNodesFromAudio(spectrum, centroid, rms) {
  state.framesSinceSpawn++;
  if (
    state.framesSinceSpawn < CONFIG.audio.spawnEvery ||
    !state.features.active
  )
    return;
  const mel = melEnergies(spectrum, {
    bands: CONFIG.audio.melBands,
    maxFreq: CONFIG.audio.maxFreq,
    sampleRate: getAudioContext().sampleRate,
  });
  spawnNode(mel, centroid, state.liveSpread, rms, player.sound.currentTime());
  state.framesSinceSpawn = 0;
}

function updateImmersionState(spec, rms, centroid) {
  const rmsLerp =
    rms > state.bass.rmsSmooth
      ? CONFIG.audio.rmsAttack
      : CONFIG.audio.rmsRelease;
  state.bass.rmsSmooth = lerp(state.bass.rmsSmooth, rms, rmsLerp);
  const bass = bandEnergy(spec, 26, 170, getAudioContext().sampleRate);
  const mid = bandEnergy(spec, 220, 2200, getAudioContext().sampleRate);
  const high = bandEnergy(spec, 2200, 7600, getAudioContext().sampleRate);
  const centroidDelta = abs(centroid - state.music.prevCentroid);
  state.music.prevCentroid = centroid;
  const melodyTarget = constrain(
    mid * 1.0 + high * 0.85 + centroidDelta * 2.2,
    0,
    1.25,
  );
  const melodyLerp =
    melodyTarget > state.music.melodyDrive
      ? CONFIG.magic.melodyAttack
      : CONFIG.magic.melodyRelease;
  state.music.melodyDrive = lerp(
    state.music.melodyDrive,
    melodyTarget,
    melodyLerp,
  );
  state.bass.base = lerp(state.bass.base, bass, 0.03);
  const rise = max(0, bass - state.bass.base * 0.97);
  state.bass.shockPulse = lerp(state.bass.shockPulse, rise * 2.3, 0.12);
  state.bass.shockPulse *= 0.95;
  if (
    rise > CONFIG.magic.boomRiseThreshold &&
    bass > CONFIG.magic.boomBassThreshold
  ) {
    state.music.boom = max(state.music.boom, CONFIG.magic.boomKick);
  }
  state.music.boom *= CONFIG.magic.boomDecay;
  const targetPulse = constrain(
    bass * 1.1 + state.bass.rmsSmooth * 0.8 + state.bass.shockPulse,
    0,
    1.2,
  );
  state.bass.pulse = lerp(state.bass.pulse, targetPulse, 0.11);
}

function spawnNode(mel, centroid, spread, rms, tSec) {
  const hue = map(centroid, 0, 1, 0, 260);
  const sz = map(rms, 0, 0.45, 22, 90);
  const cBin = floor(
    constrain(centroid, 0, 0.9999) * CONFIG.spectral.unclutterCBins,
  );
  const sBin = floor(
    constrain(spread, 0, 0.9999) * CONFIG.spectral.unclutterSBins,
  );
  const unclutterKey = cBin + '|' + sBin;
  const unclutterSlot = state.unclutterSlots.get(unclutterKey) || 0;
  state.unclutterSlots.set(unclutterKey, unclutterSlot + 1);
  const tilt = spectralTilt(mel);
  const node = {
    dx: random(-100, 100),
    dy: random(-100, 100),
    vx: random(-0.35, 0.35),
    vy: random(-0.25, 0.25),
    hue,
    sz,
    centroid,
    spread,
    tilt,
    tSec,
    unclutterSeed: (cBin * 0.37 + sBin * 0.73) % (Math.PI * 2),
    unclutterSlot,
    burstId: state.currentBurst,
    seedA: random(1000),
    seedB: random(1000),
    age: 0,
  };
  state.nodes.push(node);
  if (state.nodes.length > CONFIG.nodes.maxCount) state.nodes.shift();
}

// ═══════════════════════════════════════════════════════════════
// NODE BOUNDS & WORLD POSITIONS
// ═══════════════════════════════════════════════════════════════

function updateNodeBounds() {
  const { nodes, bounds } = state;
  if (nodes.length === 0) return;
  let cMinT = 1e9,
    cMaxT = -1e9,
    sMinT = 1e9,
    sMaxT = -1e9,
    tMinT = 1e9,
    tMaxT = -1e9;
  for (const n of nodes) {
    cMinT = min(cMinT, n.centroid);
    cMaxT = max(cMaxT, n.centroid);
    sMinT = min(sMinT, n.spread);
    sMaxT = max(sMaxT, n.spread);
    tMinT = min(tMinT, n.tilt);
    tMaxT = max(tMaxT, n.tilt);
  }
  const lf = nodes.length === 1 ? 1.0 : nodes.length < 8 ? 0.4 : 0.025;
  if (nodes.length === 1) {
    const pad = 0.05;
    cMinT -= pad;
    cMaxT += pad;
    sMinT -= pad;
    sMaxT += pad;
  }
  bounds.centroid.min = lerp(bounds.centroid.min, cMinT, lf);
  bounds.centroid.max = lerp(bounds.centroid.max, cMaxT, lf);
  bounds.spread.min = lerp(bounds.spread.min, sMinT, lf);
  bounds.spread.max = lerp(bounds.spread.max, sMaxT, lf);
  bounds.tilt.min = lerp(bounds.tilt.min, tMinT, lf);
  bounds.tilt.max = lerp(bounds.tilt.max, tMaxT, lf);
}

// Centroid and spread on a diagonal, tilt as depth, as before, but in
// world units: nothing is clamped to the screen any more.
function worldPositions() {
  const { nodes, bounds, currentBurst } = state;
  const size = CONFIG.world.size;
  const depth = CONFIG.world.depth;
  const tMaxCur = nodes.length > 0 ? nodes[nodes.length - 1].tSec : 1;
  const tMinWin = tMaxCur - CONFIG.display.windowSeconds;
  const cRange = max(bounds.centroid.max - bounds.centroid.min, 0.02);
  const sRange = max(bounds.spread.max - bounds.spread.min, 0.02);
  const tRange = max(bounds.tilt.max - bounds.tilt.min, 0.01);
  return nodes.map((n) => {
    const cn = (n.centroid - bounds.centroid.min) / cRange;
    const sn = (n.spread - bounds.spread.min) / sRange;
    const r2 = 0.7071;
    const rx = (cn - sn) * r2;
    const ry = (cn + sn) * r2;
    const warped = applyNebulaWarp(rx * size * 0.5 + n.dx, (ry - 0.7071) * size * 0.5 + n.dy, n);
    let z = map(n.tilt, bounds.tilt.min, bounds.tilt.min + tRange, -depth, depth);
    if (n.burstId === currentBurst) z += map(n.tSec, tMinWin, tMaxCur, -50, 50);
    return [warped.x, warped.y, z];
  });
}

function calculateRenderOrder(projections) {
  return nodeRenderOrder(state.nodes, projections, state.currentBurst);
}

// ═══════════════════════════════════════════════════════════════
// ATMOSPHERIC DEPTH HELPERS
// ═══════════════════════════════════════════════════════════════

function depthFog(zDepth) {
  return constrain(
    map(zDepth, CONFIG.atmosphere.fogNear, CONFIG.atmosphere.fogFar, 0, 1),
    0,
    1,
  );
}

function atmosphericAdjust(zDepth) {
  const fog = depthFog(zDepth);
  return {
    satLoss: fog * CONFIG.atmosphere.maxDesaturation,
    briLoss: fog * CONFIG.atmosphere.maxBrightnessDrop,
  };
}

// ═══════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════

function drawEdges3D(projections) {
  const K = 6,
    DMAX = 520,
    WIN = 120;
  for (let i = max(0, state.nodes.length - WIN); i < state.nodes.length; i++) {
    const pa = projections[i];
    const n = state.nodes[i];
    const isCurrent = isHighlighted(n, state.currentBurst);
    const life = constrain(1 - n.age / CONFIG.nodes.fadeFrames, 0, 1);
    for (let j = max(0, i - K); j < i; j++) {
      const pb = projections[j];
      const nb = state.nodes[j];
      const d = dist(pa.sx, pa.sy, pb.sx, pb.sy);
      if (d > DMAX) continue;
      const avgDepth = (pa.depth + pb.depth) / 2;
      const depthFade = constrain(map(avgDepth, -500, 300, 0.3, 1.0), 0.2, 1.0);
      const atmo = atmosphericAdjust(avgDepth);
      const sameBurst = n.burstId === nb.burstId && isCurrent;
      if (sameBurst) {
        const edgeHue = lerp(n.hue, nb.hue, 0.5);
        const edgeSat = max(8, 28 - atmo.satLoss * 0.4);
        stroke(
          edgeHue,
          edgeSat,
          max(60, 100 - atmo.briLoss),
          map(d, 0, DMAX, 90, 20) * depthFade,
        );
        strokeWeight(0.9);
      } else {
        stroke(
          0,
          0,
          max(40, 75 - atmo.briLoss),
          map(d, 0, DMAX, 35, 3) * life * depthFade,
        );
        strokeWeight(0.45);
      }
      line(pa.sx, pa.sy, pb.sx, pb.sy);
    }
  }
}

function drawNodes3D(renderOrder, projections) {
  const hlCfg = CONFIG.highlight;
  for (const idx of renderOrder) {
    const n = state.nodes[idx];
    const p = projections[idx];
    const isCurrent = isHighlighted(n, state.currentBurst);
    const life = constrain(1 - n.age / CONFIG.nodes.fadeFrames, 0, 1);
    const atmo = atmosphericAdjust(p.depth);
    const depthFade = constrain(map(p.depth, -500, 300, 0.45, 1.0), 0.35, 1.0);
    const sizeMult = isCurrent ? 1.0 : pow(life, 0.65);
    const alpha = isCurrent ? 95 * depthFade : pow(life, 1.6) * 85 * depthFade;
    if (alpha < 1.5 || sizeMult < 0.05) continue;
    const sz3 = constrain(n.sz * p.sc * sizeMult, 1, isCurrent ? 110 : 75);
    const nodeSat = isCurrent ? 0 : max(30, 70 - atmo.satLoss * 0.6);
    const nodeBri = max(55, 100 - atmo.briLoss);

    // ── BURST HIGHLIGHT (multi-layer glow + beacon — always visible) ──
    if (isCurrent) {
      for (let g = hlCfg.glowLayers - 1; g >= 0; g--) {
        const glowSize = sz3 * hlCfg.glowExpand[g];
        const effectiveSize = max(glowSize, 8 + g * 4);
        const glowWeight = max(hlCfg.minStrokeWeight, hlCfg.glowStroke[g]);
        noFill();
        stroke(
          n.hue,
          max(10, 50 - atmo.satLoss * 0.5),
          nodeBri,
          hlCfg.glowAlpha[g] * depthFade,
        );
        strokeWeight(glowWeight);
        rectMode(CENTER);
        rect(p.sx, p.sy, effectiveSize, effectiveSize);
      }
      noStroke();
      fill(n.hue, 30, 100, hlCfg.beaconAlpha * depthFade);
      const beaconR = max(hlCfg.beaconMinRadius, sz3 * 0.18);
      ellipse(p.sx, p.sy, beaconR * 2, beaconR * 2);
    }

    // ── Node square outline ──
    noFill();
    stroke(n.hue, nodeSat, nodeBri, alpha);
    strokeWeight(isCurrent ? 1.8 : max(0.2, 0.8 * sizeMult));
    rectMode(CENTER);
    rect(p.sx, p.sy, sz3, sz3);

    // ── Node center dot ──
    noStroke();
    fill(n.hue, max(50, 88 - atmo.satLoss * 0.5), nodeBri, alpha);
    ellipse(p.sx, p.sy, sz3 * 0.28, sz3 * 0.28);

    // ── Labels ──
    if (sz3 > 7 && (isCurrent || life > 0.3)) {
      drawNodeLabel(n, p, alpha, sz3, atmo);
    }
  }
}

function drawNodeLabel(n, p, alpha, sz3, atmo) {
  const fs = max(5, 7 * p.sc);
  const half = sz3 / 2;
  const labelBri = max(45, 92 - (atmo ? atmo.briLoss : 0));
  noStroke();
  textSize(fs);
  textAlign(RIGHT);
  fill(n.hue, 60, labelBri, alpha * 0.82);
  text(
    ((n.centroid * getAudioContext().sampleRate) / 2 / 1000).toFixed(2) + 'k',
    p.sx - half - 4,
    p.sy + fs * 0.35,
  );
  textAlign(LEFT);
  fill(0, 0, max(40, 72 - (atmo ? atmo.briLoss * 0.5 : 0)), alpha * 0.72);
  text(
    ((n.spread * getAudioContext().sampleRate) / 2 / 1000).toFixed(2) + 'k',
    p.sx + half + 4,
    p.sy + fs * 0.35,
  );
}

// a small axis cross at the centre of the box
function drawAxisCross() {
  const len = 60;
  const [cx, cy, cz] = boxCenter();
  const o = orbit.project([cx, cy, cz], width, height);
  const px = orbit.project([cx + len, cy, cz], width, height);
  const py = orbit.project([cx, cy + len, cz], width, height);
  const pz = orbit.project([cx, cy, cz + len], width, height);
  strokeWeight(0.5);
  stroke(0, 40, 60, 15);
  line(o.sx, o.sy, px.sx, px.sy);
  stroke(120, 40, 60, 15);
  line(o.sx, o.sy, py.sx, py.sy);
  stroke(220, 40, 60, 15);
  line(o.sx, o.sy, pz.sx, pz.sy);
  noStroke();
  fill(0, 0, 40, 12);
  ellipse(o.sx, o.sy, 4, 4);
}

function drawOrbitHint() {
  if (width < 800) return;
  const tMaxCur =
    state.nodes.length > 0 ? state.nodes[state.nodes.length - 1].tSec : 1;
  const tMinWin = tMaxCur - CONFIG.display.windowSeconds;
  const cx = width / 2,
    cy = height - 44,
    rw = 58,
    rh = 15;
  noFill();
  stroke(0, 0, 26, 30);
  strokeWeight(0.7);
  ellipse(cx, cy, rw * 2, rh * 2);
  const tx = cx + cos(orbit.yaw) * rw;
  const ty = cy + sin(orbit.yaw) * rh;
  stroke(0, 0, 52, 48);
  strokeWeight(1);
  line(cx, cy, tx, ty);
  noStroke();
  fill(0, 0, 65, 58);
  ellipse(tx, ty, 3.5, 3.5);
  noStroke();
  fill(0, 0, 32);
  textSize(8);
  textAlign(CENTER);
  text(
    't=' +
      max(0, tMinWin).toFixed(1) +
      's \u2192 ' +
      tMaxCur.toFixed(1) +
      's | burst #' +
      state.currentBurst,
    cx,
    cy - rh - 5,
  );
  fill(0, 0, 24);
  text(orbit.auto ? 'drag \u00b7 click to stop' : 'drag \u00b7 click to spin', cx, cy + rh + 11);
}

// ── FREQUENCY BAR (live spectrum overlay + centroid marker) ──

function drawFreqBar() {
  const barWidth = min(480, width - 44),
    barHeight = 9,
    bx = 22,
    by = 16;

  // Static rainbow gradient (reference scale)
  for (let i = 0; i < barWidth; i++) {
    stroke(map(i, 0, barWidth, 0, 260), 90, 95, 88);
    strokeWeight(1);
    line(bx + i, by, bx + i, by + barHeight);
  }

  // Live spectrum overlay
  if (state.liveSpectrum && player.isPlaying) {
    const spec = state.liveSpectrum;
    const nyquist = getAudioContext().sampleRate / 2;
    const maxFreqBin = constrain(
      floor((CONFIG.audio.maxFreq / nyquist) * spec.length),
      0,
      spec.length - 1,
    );
    const overlayH = 28;
    noStroke();
    for (let i = 0; i < barWidth; i++) {
      const bin = floor(map(i, 0, barWidth, 0, maxFreqBin));
      const energy = spec[bin] / 255;
      if (energy < 0.02) continue;
      const h = energy * overlayH;
      fill(map(i, 0, barWidth, 0, 260), 70, 100, 35 + energy * 40);
      rect(bx + i, by - h, 1, h);
    }

    // Centroid hairline
    const centroidHz = state.liveCentroid * nyquist;
    const centroidX =
      bx + constrain(centroidHz / CONFIG.audio.maxFreq, 0, 1) * barWidth;
    stroke(0, 0, 100, 70);
    strokeWeight(1.2);
    line(centroidX, by - overlayH - 2, centroidX, by + barHeight + 2);

    // Spread bracket
    const spreadHalfPx =
      ((state.liveSpread * nyquist) / CONFIG.audio.maxFreq) * barWidth * 0.5;
    stroke(0, 0, 60, 30);
    strokeWeight(0.6);
    line(
      centroidX - spreadHalfPx,
      by - overlayH - 2,
      centroidX + spreadHalfPx,
      by - overlayH - 2,
    );

    // Centroid label
    noStroke();
    fill(0, 0, 72, 60);
    textSize(7);
    textAlign(CENTER);
    text(
      ((state.liveCentroid * getAudioContext().sampleRate) / 2 / 1000).toFixed(
        1,
      ) + 'k',
      centroidX,
      by + barHeight + 7,
    );
  }

  // Hz scale labels
  noStroke();
  fill(0, 0, 70);
  textSize(9);
  textAlign(LEFT);
  Array.from(
    { length: 5 },
    (_, i) => ((i * CONFIG.audio.maxFreq) / 4 / 1000).toFixed(1) + 'k',
  ).forEach((label, i) => {
    text(
      label + ' Hz',
      bx + (i * barWidth) / 4 - (i > 0 ? 10 : 0),
      by + barHeight + 11,
    );
  });
}

function drawReadoutPanel() {
  if (width < 800) return;
  if (!player.isPlaying || !player.isLoaded) return;
  const cfg = CONFIG.readout;
  let y = cfg.y;
  const x = cfg.x;
  noStroke();
  textSize(8);
  textAlign(LEFT);
  const entries = [
    ['RMS', state.liveRMS.toFixed(4)],
    [
      'CENTROID',
      ((state.liveCentroid * getAudioContext().sampleRate) / 2).toFixed(0) +
        ' Hz',
    ],
    [
      'SPREAD',
      ((state.liveSpread * getAudioContext().sampleRate) / 2).toFixed(0) +
        ' Hz',
    ],
    ['FLUX', state.liveFlux.toFixed(4)],
    ['BASS', state.bass.pulse.toFixed(3)],
    ['MELODY', state.music.melodyDrive.toFixed(3)],
    ['BOOM', state.music.boom.toFixed(3)],
    ['NODES', state.nodes.length + '/' + CONFIG.nodes.maxCount],
    ['BURST', '#' + state.currentBurst],
    ['BOX', boxSize().map((v) => v.toFixed(0)).join(' \u00d7 ')],
  ];
  for (const [label, value] of entries) {
    fill(0, 0, cfg.labelColor);
    text(label, x, y);
    fill(0, 0, cfg.valueColor);
    text(value, x + 58, y);
    y += cfg.lineHeight;
  }
}

function drawStars() {
  noStroke();
  const twinkle = 40 + state.bass.pulse * 32;
  for (const s of state.stars) {
    fill(0, 0, random(30, twinkle), 50);
    ellipse(
      s.x,
      s.y,
      s.r + state.bass.pulse * 0.35,
      s.r + state.bass.pulse * 0.35,
    );
  }
}

function drawVignette() {
  const layers = 12;
  noFill();
  for (let i = 0; i < layers; i++) {
    const f = i / max(1, layers - 1);
    const w = lerp(width * 0.96, width * 1.32, f);
    const h = lerp(height * 0.96, height * 1.42, f);
    const a = 2 + f * (6 + state.bass.pulse * 8);
    stroke(0, 0, 0, a);
    strokeWeight(30);
    ellipse(width * 0.5, height * 0.5, w, h);
  }
}

// ═══════════════════════════════════════════════════════════════
// PHYSICS
// ═══════════════════════════════════════════════════════════════

function applyRepulsion() {
  const { nodes, currentBurst } = state;
  const cfg = CONFIG.nodes;
  const burstIndices = [];
  let centerX = 0,
    centerY = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].burstId !== currentBurst) continue;
    burstIndices.push(i);
    centerX += nodes[i].dx;
    centerY += nodes[i].dy;
  }
  if (burstIndices.length < 2) return;
  centerX /= burstIndices.length;
  centerY /= burstIndices.length;
  const density = constrain(
    map(burstIndices.length, 8, 80, 0.85, 1.25),
    0.85,
    1.25,
  );
  const boomMul = lerp(
    1,
    CONFIG.magic.boomRepelMul,
    constrain(state.music.boom, 0, 1),
  );
  const minDist = cfg.repelDistance * density * boomMul;
  const repelForce = cfg.repelForce * density * boomMul;
  for (let a = 0; a < burstIndices.length; a++) {
    const i = burstIndices[a];
    for (let b = a + 1; b < burstIndices.length; b++) {
      const j = burstIndices[b];
      const ddx = nodes[i].dx - nodes[j].dx;
      const ddy = nodes[i].dy - nodes[j].dy;
      const d = sqrt(ddx * ddx + ddy * ddy);
      if (d < minDist && d > 0.5) {
        const force = ((minDist - d) / minDist) * repelForce;
        nodes[i].dx += (ddx / d) * force;
        nodes[i].dy += (ddy / d) * force;
        nodes[j].dx -= (ddx / d) * force;
        nodes[j].dy -= (ddy / d) * force;
      }
    }
  }
  for (let a = 0; a < burstIndices.length; a++) {
    const i = burstIndices[a];
    const ox = nodes[i].dx - centerX,
      oy = nodes[i].dy - centerY;
    const d = sqrt(ox * ox + oy * oy);
    if (d < 1) continue;
    const ageBoost = constrain(map(nodes[i].age, 0, 120, 1.0, 0.0), 0, 1);
    const push = cfg.swellForce * density * ageBoost;
    nodes[i].vx += (ox / d) * push;
    nodes[i].vy += (oy / d) * push;
  }
}

// ═══════════════════════════════════════════════════════════════
// INPUT & INTERACTION
// ═══════════════════════════════════════════════════════════════

// Drag turns the camera around the box; a click without dragging
// starts or stops the automatic turning.
function mousePressed(event) {
  if (event?.target?.tagName !== 'CANVAS') return;
  state.drag.active = true;
  state.drag.travel = 0;
}

function mouseDragged() {
  if (!state.drag.active) return;
  state.drag.travel += abs(movedX) + abs(movedY);
  orbit.drag(movedX, movedY);
}

function mouseReleased() {
  if (state.drag.active && state.drag.travel < 4) orbit.toggle();
  state.drag.active = false;
}

function keyPressed(event) {
  if (event?.target?.closest('input, textarea, [contenteditable]')) return;
  if (key === ' ' && event?.target?.closest('button, summary, a')) return;
  if (key === ' ') {
    player.togglePlay();
    return false;
  }
  if (key === 'c' || key === 'C') resetAudioState();
  if (key === 'f' || key === 'F') toggleFullscreen();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ─────────────────────────────────────────────────────────────
// FULLSCREEN & SCENE RESET
// ─────────────────────────────────────────────────────────────

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    player.error = 'Fullscreen is unavailable in this browser.';
    ui.update();
  }
}

function resetAudioState() {
  state.nodes = [];
  state.analysis = new AdaptiveAnalysis();
  state.analysisElapsed = 0;
  state.features = { active: false, level: 0 };
  state.currentBurst = 0;
  state.framesSinceSpawn = 0;
  state.unclutterSlots = new Map();
  state.liveSpectrum = null;
  state.liveCentroid = 0;
  state.liveSpread = 0;
  state.liveRMS = 0;
  state.liveFlux = 0;
  state.bounds.centroid = { min: 0.3, max: 0.7 };
  state.bounds.spread = { min: 0.1, max: 0.4 };
  state.bounds.tilt = { min: 0.3, max: 0.7 };
  state.box = { min: null, max: null };
  state.bass = { pulse: 0, base: 0, shockPulse: 0, rmsSmooth: 0 };
  state.music = { melodyDrive: 0, boom: 0, prevCentroid: 0 };
  orbit.reset();
}

// p5 global mode discovers lifecycle callbacks on window.
Object.assign(window, {
  setup,
  draw,
  mousePressed,
  mouseReleased,
  mouseDragged,
  keyPressed,
  windowResized,
});
