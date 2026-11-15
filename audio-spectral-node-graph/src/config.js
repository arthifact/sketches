// Scene tuning. Node lifetimes use frames at 60 Hz; box rates are per second.
const CONFIG = {
  world: {
    size: 1000, // width of the centroid-spread plane
    depth: 320, // tilt spans -depth to depth
  },

  box: {
    pad: 30, // world units around the outermost nodes
    rest: 200, // half size before any sound
    growRate: 9,
    shrinkRate: 2,
  },

  audio: {
    fftBins: 1024,
    melBands: 40,
    maxFreq: 14000,
    spawnEvery: 1,
    rmsAttack: 0.22,
    rmsRelease: 0.025,
  },

  nodes: {
    maxCount: 250,
    fadeFrames: 200,
    repelDistance: 44,
    repelForce: 0.28,
    swellForce: 0.032,
  },

  spectral: {
    unclutterCBins: 32,
    unclutterSBins: 22,
    unclutterStepPx: 6.0,
    unclutterMaxPx: 26,
    unclutterStrength: 0.82,
  },

  display: {
    windowSeconds: 11,
    starCount: 180,
  },

  composition: {
    warpAmount: 0.078,
    warpBreath: 0.048,
  },

  flow: {
    driftAccel: 0.013,
    driftNoiseSpeed: 0.003,
    driftDamping: 0.968,
    driftMaxVel: 2.4,
    driftBurstBoost: 3.2,
  },

  magic: {
    boomRiseThreshold: 0.028,
    boomBassThreshold: 0.09,
    boomKick: 1.0,
    boomDecay: 0.88,
    boomOutwardForce: 0.24,
    boomRepelMul: 2.4,
    melodyAttack: 0.24,
    melodyRelease: 0.035,
    melodyDriftBoost: 2.8,
    melodyWarpBoost: 0.08,
  },

  highlight: {
    minStrokeWeight: 1.8,
    glowLayers: 5,
    glowExpand: [1.3, 1.7, 2.2, 2.9, 3.6],
    glowAlpha: [48, 30, 18, 9, 4],
    glowStroke: [1.6, 1.2, 0.8, 0.5, 0.3],
    beaconMinRadius: 4.0,
    beaconAlpha: 85,
  },

  atmosphere: {
    fogNear: -200,
    fogFar: 500,
    maxDesaturation: 38,
    maxBrightnessDrop: 18,
  },

  readout: {
    x: 22,
    y: 68,
    lineHeight: 13,
    labelColor: 28,
    valueColor: 52,
  },
};

export default CONFIG;
