export const GATE_SELF_PROBE_TICK_TEMPLATE = {
  id: 'development-vessel:gate-self-probe-tick',
  name: 'gate-self-probe-tick',
  inputShapes: [],
  tasks: [
    {
      resolver: 'gate_self_probe',
      config: { type: 'gate_self_probe' },
      id: '',
      description: ''
    }
  ],
  outputShapes: ["gateSelfProbe"],
  tags: ["intent:horizon_detection", "horizon:meta", "phase:detect", "boredom_target_template", "lift.autonomous.loop", "light_dispatch_eligible"]
};