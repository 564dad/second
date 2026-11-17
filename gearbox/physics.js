/*
 * gearbox/physics.js — 齿轮箱确定性物理引擎（无 DOM 依赖，可在 Node 中做无头验证）
 *
 * 设计要点：
 *  - 固定步长 DT = 1/180 s；松旷工况内部再分 12 个半隐式欧拉子步，
 *    接触刚度按显式积分稳定性条件标定（h < 2/ωn，留 1.7 倍以上裕度）。
 *  - 所有随机量来自种子化 mulberry32，仿真步骤内不使用 Date.now / Math.random，
 *    因此同参数重复运行逐位一致；暂停与单步走的是同一个 step()，物理状态必然相同。
 *  - 任何物理量越过硬件上下限立即“跳闸”：记录触发点快照并冻结，不再继续积分。
 */
(function (global) {
  'use strict';

  /* ---------------- 种子化伪随机（mulberry32） ---------------- */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function rng() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 几何与硬件常量 ---------------- */
  const MODULE_MM = 2.5;                 // 齿轮模数 m = 2.5 mm
  const FACE_WIDTH_MM = 20;              // 齿宽
  // 健康啮合齿数和：AB=64（80mm），BC=56（70mm）
  const SHAFT_DIST_MM = { AB: 80, BC: 70 };
  const MESH_TOL_MM = 1.2;               // 健康啮合允许的中心距偏差
  const HEALTHY_BACKLASH_MM = 0.02;      // 健康啮合单侧等效齿侧间隙
  const BACKLASH_FACTOR = 0.73;          // 中心距误差 -> 切向侧隙（20° 压力角 2tanα）
  const LOAD_RAMP_S = 0.5;               // 负载施加斜坡，避免 t=0 冲击
  const SPEED_RAMP_S = 1.2;              // 电机目标转速启动斜坡（软启动）
  const VIBRATION_GRACE_S = 0.3;         // 启动宽限窗：期间不判失稳

  const DT = 1 / 180;                    // 固定物理步长 (s)
  const LOOSE_SUBSTEPS = 12;             // 松旷积分子步数
  const RECORD_EVERY = 3;                // 每 3 步录一帧（60 Hz 回放缓冲）
  const DEFAULT_SEED = 20261117;

  const STEEL_RHO = 7850;                // kg/m^3

  // 硬件/工艺上下限（越限即跳闸，显示触发点而不是继续计算）
  const LIMITS = Object.freeze({
    inputSpeed: { min: 200, max: 1400, unit: 'rpm', label: '输入转速' },
    outputSpeed: { min: 0, max: 2000, unit: 'rpm', label: '输出转速' },
    load: { min: 0, max: 200, unit: 'N·m', label: '负载扭矩' },
    pressure: { min: 0, max: 800, unit: 'MPa', label: '接触压力' },
    temperature: { min: 0, max: 120, unit: '°C', label: '油温' },
    vibration: { min: 0, max: 100, unit: 'mm/s', label: '振动速度（ISO 严重停机阈值）' }
  });

  const MOTOR_MAX_TORQUE = 340;          // N·m（容量覆盖负载上限经最大速比折算值）
  const MOTOR_TORQUE_SLEW = 2000;        // N·m/s，扭矩变化率限制（仅滤除零时刻阶跃）
  const SPEED_KP = 0.2;                  // 电机转速闭环 PI（离散稳定域内整定，见验证报告）
  const SPEED_KI = 12;
  const I_TERM_CLAMP = 310;
  const FRICTION_B = 0.012;              // 粘性摩擦 N·m·s/rad
  // 接触压力换算：σ = F / (齿宽 × 等效接触半宽)。重载齿面等效接触半宽按 0.4mm 标定，
  // 齿宽 20mm → 有效面积 8e-6 m²；满载 ~14kN 切向力 ≈ 800MPa，落在强度限值附近。
  const CONTACT_AREA_M2 = FACE_WIDTH_MM / 1000 * 0.0004;
  const TEMP_AMBIENT = 25;               // 环境温度 °C
  const TEMP_C = 4200;                   // 集总热容量 J/K（时间常数 ≈ C/H ≈ 160s）
  const TEMP_H = 26;                     // 散热系数 W/K
  const CONTACT_K = 6e4;                 // 齿面等效接触刚度 N/m（显式积分稳定标定）
  const DAMP_RATIO = 0.22;               // 接触阻尼比

  const GEAR_TEETH_CHOICES = [16, 20, 24, 28, 32, 36, 40, 48];

  function pitchRadiusMM(teeth) { return (teeth * MODULE_MM) / 2; }

  function gearInertia(teeth) {
    // 实心圆盘 I = 0.5 * rho * pi * b * r^4
    const r = pitchRadiusMM(teeth) / 1000;
    const b = FACE_WIDTH_MM / 1000;
    return 0.5 * STEEL_RHO * Math.PI * b * Math.pow(r, 4);
  }

  /* 评估三个齿轮与固定轴距的匹配情况 */
  function evaluateMeshes(teeth) {
    const r = teeth.map(pitchRadiusMM);
    const AB = SHAFT_DIST_MM.AB - (r[0] + r[1]); // 正=偏松有间隙，负=偏紧过盈
    const BC = SHAFT_DIST_MM.BC - (r[1] + r[2]);
    function classify(gap) {
      if (gap < -MESH_TOL_MM) return 'tight';
      if (gap > MESH_TOL_MM) return 'loose';
      return 'healthy';
    }
    const sAB = classify(AB);
    const sBC = classify(BC);
    let overall = 'healthy';
    if (sAB === 'tight' || sBC === 'tight') overall = 'tight';
    else if (sAB === 'loose' || sBC === 'loose') overall = 'loose';
    return {
      gaps: { AB, BC },
      mesh: { AB: sAB, BC: sBC },
      status: overall,
      ratio: teeth[0] / teeth[2] // 输出/输入转速比（中间轮为惰轮，不影响速比）
    };
  }

  function expectedOutputRpm(cfg) {
    return cfg.inputRpm * (cfg.teeth[0] / cfg.teeth[2]);
  }

  /* ---------------- 仿真器 ---------------- */
  class GearboxSim {
    constructor(cfg) {
      this.cfg = {
        teeth: cfg.teeth.slice(),
        inputRpm: cfg.inputRpm,
        loadNm: cfg.loadNm,
        seed: cfg.seed == null ? DEFAULT_SEED : cfg.seed
      };
      this.geom = evaluateMeshes(this.cfg.teeth);
      this.I = this.cfg.teeth.map(gearInertia);
      this.r = this.cfg.teeth.map((z) => pitchRadiusMM(z) / 1000); // m

      // 每级啮合各自的侧隙（m）：松旷量由中心距误差换算，健康级近似刚性
      this.bAB = this.geom.mesh.AB === 'loose'
        ? BACKLASH_FACTOR * this.geom.gaps.AB / 1000
        : HEALTHY_BACKLASH_MM / 1000;
      this.bBC = this.geom.mesh.BC === 'loose'
        ? BACKLASH_FACTOR * this.geom.gaps.BC / 1000
        : HEALTHY_BACKLASH_MM / 1000;

      // 每级啮合的等效平动质量与接触阻尼
      const mA = this.I[0] / this.r[0] ** 2, mB = this.I[1] / this.r[1] ** 2,
        mC = this.I[2] / this.r[2] ** 2;
      const mredAB = (mA * mB) / (mA + mB);
      const mredBC = (mB * mC) / (mB + mC);
      this.cAB = DAMP_RATIO * 2 * Math.sqrt(CONTACT_K * mredAB);
      this.cBC = DAMP_RATIO * 2 * Math.sqrt(CONTACT_K * mredBC);

      this._initKinematics();
      this.stepCount = 0;
      this.reset();
    }

    /* 初始相位：让啮合点处两轮齿廓对齐（无跳变初始条件）。
     * 松旷级把初始位置放在齿面接触边界（间隙为零），
     * 这样失稳是在旋转过程中因齿面分离-再接触发展出来，而非首步自由穿越。 */
    _initKinematics() {
      const [zA, zB, zC] = this.cfg.teeth;
      this.theta0 = [0, Math.PI / zB, Math.PI / zC];
      const offAB = (this.geom.mesh.AB === 'loose' ? this.bAB / 2 : 0);
      const offBC = (this.geom.mesh.BC === 'loose' ? this.bBC / 2 : 0);
      this.q0_AB = this.r[0] * this.theta0[0] + this.r[1] * this.theta0[1] - offAB;
      this.q0_BC = this.r[1] * this.theta0[1] + this.r[2] * this.theta0[2] - offBC;
      // 刚性模式等效惯量（全部折算到输入轴）
      this.Ieff = this.I[0]
        + this.I[1] * Math.pow(zA / zB, 2)
        + this.I[2] * Math.pow(zA / zC, 2);
    }

    /* 斜坡施加的负载（N·m），避免零时刻扭矩阶跃 */
    appliedLoad() {
      return this.cfg.loadNm * Math.min(1, this.t / LOAD_RAMP_S);
    }

    /* 软启动：目标角速度随斜坡建立（rad/s） */
    targetOmega() {
      return (this.cfg.inputRpm * 2 * Math.PI / 60) * Math.min(1, this.t / SPEED_RAMP_S);
    }

    reset() {
      this.t = 0;
      this.stepCount = 0;
      this.theta = this.theta0.slice();
      this.omega = [0, 0, 0];                 // rad/s
      this.tempC = TEMP_AMBIENT;
      this.vibrationMmS = 0;
      this.vibEnvelope = 0;
      this.pressureMPa = 0;
      this.forces = { AB: 0, BC: 0 };
      this.fault = null;
      this.rng = makeRng(this.cfg.seed);
      this.recorder = [];
      this.iTerm = 0;
      this.Tmotor = 0;
      this._lastRipple = 0;

      // 设定值越限：在 t=0 即触发，拒绝继续计算
      if (this.cfg.inputRpm < LIMITS.inputSpeed.min ||
          this.cfg.inputRpm > LIMITS.inputSpeed.max) {
        this._trip('speed', `输入转速 ${this.cfg.inputRpm} rpm 超出允许范围 ` +
          `${LIMITS.inputSpeed.min}~${LIMITS.inputSpeed.max} rpm`);
      } else if (this.cfg.loadNm < LIMITS.load.min ||
                 this.cfg.loadNm > LIMITS.load.max) {
        this._trip('load', `负载 ${this.cfg.loadNm} N·m 超出允许范围 ` +
          `0~${LIMITS.load.max} N·m`);
      } else if (this.geom.status === 'tight') {
        const which = this.geom.mesh.AB === 'tight' ? 'AB' : 'BC';
        const gap = this.geom.gaps[which];
        this._trip('jam', `轴距过紧（${which} 过盈 ${Math.abs(gap).toFixed(2)} mm），齿轮无法安装啮合`);
      }
      this._record(true);
      return this.snapshot();
    }

    /* 推进一个固定步长；跳闸后为空操作（状态冻结） */
    step() {
      if (this.fault) return this.snapshot();
      if (this.geom.status === 'loose') this._stepLoose(DT);
      else this._stepRigid(DT);
      this.stepCount++;
      this.t += DT;
      this._checkLimits();
      this._record(false);
      return this.snapshot();
    }

    /* 健康啮合：刚性运动学 + 电机 PI 闭环 + 确定性扭矩纹波 */
    _stepRigid(dt) {
      const [zA, zB, zC] = this.cfg.teeth;
      const wTarget = this.targetOmega();
      const err = wTarget - this.omega[0];
      // 条件积分抗饱和：若 PI 输出已饱和且当前误差会把它推向更深饱和，则冻结积分
      const iTrial = this.iTerm + err * dt;
      const uTrial = SPEED_KP * err + SPEED_KI * iTrial;
      const windup = (uTrial > MOTOR_MAX_TORQUE && err > 0)
        || (uTrial < -MOTOR_MAX_TORQUE && err < 0);
      if (!windup) this.iTerm = iTrial;
      this.iTerm = Math.max(-I_TERM_CLAMP, Math.min(I_TERM_CLAMP, this.iTerm));
      // 四象限电机：可施加反向制动扭矩；扭矩经斜率限制，避免零时刻阶跃
      const Tcmd = Math.max(-MOTOR_MAX_TORQUE,
        Math.min(MOTOR_MAX_TORQUE, SPEED_KP * err + SPEED_KI * this.iTerm));
      const dTmax = MOTOR_TORQUE_SLEW * dt;
      this.Tmotor = Math.max(this.Tmotor - dTmax,
        Math.min(this.Tmotor + dTmax, Tcmd));
      const Tm = this.Tmotor;
      const load = this.appliedLoad();
      const TloadRef = load * (zA / zC);

      // 确定性纹波：啮合频率正弦 + 每步固定一次种子随机抽取
      const meshFreq = (zA * this.omega[0]) / (2 * Math.PI);
      const ripple = 0.02 * Tm * Math.sin(2 * Math.PI * meshFreq * this.t)
        + (this.rng() - 0.5) * 0.03 * Tm;
      this._lastRipple = ripple;

      const alpha = (Tm - TloadRef - FRICTION_B * this.omega[0] + ripple) / this.Ieff;
      this.omega[0] += alpha * dt;
      this.theta[0] += this.omega[0] * dt;
      this.theta[1] = this.theta0[1] - (this.theta[0] - this.theta0[0]) * (zA / zB);
      this.theta[2] = this.theta0[2] + (this.theta[0] - this.theta0[0]) * (zA / zC);
      this.omega[1] = -this.omega[0] * (zA / zB);
      this.omega[2] = this.omega[0] * (zA / zC);

      // 显示用啮合力（切向）
      this.forces.AB = Math.abs(Tm) / this.r[0];
      this.forces.BC = Math.abs(load) / this.r[2];
      this.pressureMPa = Math.max(this.forces.AB, this.forces.BC) / CONTACT_AREA_M2 / 1e6;
      // 健康工况振动来自扭矩纹波（启动加速度属于正常工况，不判失稳）。
      // 纹波扭矩 -> 切向力波动 -> 输出轴径向振动速度，标定到 0.2~2 mm/s 区间。
      this.vibrationMmS = 0.2 + Math.abs(ripple) / this.r[2] * 0.0009;

      // 热模型：负载功率经啮合损耗（12%，重载工况效率约 88%）转热 + 粘性摩擦热，
      // 散热与温差成正比；满载持续运行时温度可在十分钟级逼近热极限。
      const Pheat = TloadRef * Math.abs(this.omega[0]) * 0.12
        + FRICTION_B * this.omega[0] * this.omega[0];
      this._integrateTemp(Pheat, dt);
    }

    /* 松旷啮合：三自由度半隐式欧拉，两级齿侧间隙接触/碰撞统一处理 */
    _stepLoose(dt) {
      const h = dt / LOOSE_SUBSTEPS;
      const [rA, rB, rC] = this.r;
      const [IA, IB, IC] = this.I;
      const [zA, , zC] = this.cfg.teeth;
      const wTarget = this.targetOmega();
      let maxForce = 0, heatImpact = 0, maxVib = 0;

      for (let s = 0; s < LOOSE_SUBSTEPS; s++) {
        let tA = 0, tB = 0, tC = 0;

        // --- AB 接触对 ---
        const qAB = rA * this.theta[0] + rB * this.theta[1] - this.q0_AB;
        const qdAB = rA * this.omega[0] + rB * this.omega[1];
        let fAB = 0;
        if (Math.abs(qAB) >= this.bAB / 2) {
          const sgn = Math.sign(qAB);
          const pen = Math.abs(qAB) - this.bAB / 2;
          fAB = sgn * (CONTACT_K * pen + this.cAB * qdAB * sgn);
          tA += -fAB * rA;
          tB += -fAB * rB;
          heatImpact += Math.abs(this.cAB * qdAB * sgn * qdAB) * h;
        }

        // --- BC 接触对 ---
        const qBC = rB * this.theta[1] + rC * this.theta[2] - this.q0_BC;
        const qdBC = rB * this.omega[1] + rC * this.omega[2];
        let fBC = 0;
        if (Math.abs(qBC) >= this.bBC / 2) {
          const sgn = Math.sign(qBC);
          const pen = Math.abs(qBC) - this.bBC / 2;
          fBC = sgn * (CONTACT_K * pen + this.cBC * qdBC * sgn);
          tB += -fBC * rB;
          tC += -fBC * rC;
          heatImpact += Math.abs(this.cBC * qdBC * sgn * qdBC) * h;
        }

        const Tcmd = Math.max(-MOTOR_MAX_TORQUE,
          Math.min(MOTOR_MAX_TORQUE, SPEED_KP * (wTarget - this.omega[0])));
        const dTmax = MOTOR_TORQUE_SLEW * h;
        this.Tmotor = Math.max(this.Tmotor - dTmax,
          Math.min(this.Tmotor + dTmax, Tcmd));
        const Tm = this.Tmotor;
        const load = this.appliedLoad();
        const a0 = (Tm + tA - FRICTION_B * this.omega[0]) / IA;
        const a1 = (tB - FRICTION_B * this.omega[1]) / IB;
        const a2 = (-load + tC - FRICTION_B * this.omega[2]) / IC;
        this.omega[0] += a0 * h;
        this.omega[1] += a1 * h;
        this.omega[2] += a2 * h;
        this.theta[0] += this.omega[0] * h;
        this.theta[1] += this.omega[1] * h;
        this.theta[2] += this.omega[2] * h;

        maxForce = Math.max(maxForce, Math.abs(fAB), Math.abs(fBC));
        const wCkin = this.omega[0] * (zA / zC);
        maxVib = Math.max(maxVib, Math.abs(this.omega[2] - wCkin) * rC * 1000);
      }

      this.forces.AB = maxForce;
      this.forces.BC = maxForce;
      this.pressureMPa = maxForce / CONTACT_AREA_M2 / 1e6;
      // 振动判据采用冲击峰值的衰减包络（时间常数 0.25s）：
      // 启动初期的单次冲击会自然衰减，只有持续再冲击（包络增长）才判失稳。
      const instVib = maxVib;
      const decay = Math.exp(-dt / 0.25);
      this.vibEnvelope = Math.max(instVib, this.vibEnvelope * decay);
      this.vibrationMmS = this.vibEnvelope;
      const Pheat = FRICTION_B * this.omega[2] * this.omega[2]
        + (heatImpact / dt) * 0.35;
      this._integrateTemp(Pheat, dt);
    }

    _integrateTemp(Pheat, dt) {
      const dT = (Pheat - TEMP_H * (this.tempC - TEMP_AMBIENT)) / TEMP_C * dt;
      this.tempC += dT;
      if (this.tempC < TEMP_AMBIENT) this.tempC = TEMP_AMBIENT;
    }

    _checkLimits() {
      const outRpm = Math.abs(this.omega[2]) * 60 / (2 * Math.PI);
      // 失稳先于超速判定：松旷冲击本身就是要被捕获的异常。
      // 启动宽限窗（软启动期间的齿面磨合冲击不判失稳，只记录数值）。
      if (this.vibrationMmS > LIMITS.vibration.max && this.t > VIBRATION_GRACE_S) {
        this._trip('instability',
          `振动速度 ${this.vibrationMmS.toFixed(1)} mm/s 超过失稳阈值 ${LIMITS.vibration.max} mm/s`);
      } else if (this.pressureMPa > LIMITS.pressure.max) {
        this._trip('pressure',
          `接触压力 ${this.pressureMPa.toFixed(0)} MPa 超过强度极限 ${LIMITS.pressure.max} MPa`);
      } else if (this.tempC > LIMITS.temperature.max) {
        this._trip('temperature',
          `油温 ${this.tempC.toFixed(1)} °C 超过热极限 ${LIMITS.temperature.max} °C`);
      } else if (outRpm > LIMITS.outputSpeed.max) {
        this._trip('speed',
          `输出转速 ${outRpm.toFixed(0)} rpm 超过超速极限 ${LIMITS.outputSpeed.max} rpm`);
      }
    }

    _trip(code, message) {
      if (this.fault) return;
      this.fault = { code, message, t: this.t, step: this.stepCount, snap: this.snapshot() };
    }

    _record(force) {
      if (force || this.stepCount % RECORD_EVERY === 0) {
        this.recorder.push(this.snapshot());
      }
    }

    snapshot() {
      return {
        t: this.t,
        theta: this.theta.slice(),
        omega: this.omega.slice(),
        rpm: this.omega.map((w) => (w * 60) / (2 * Math.PI)),
        tempC: this.tempC,
        pressureMPa: this.pressureMPa,
        forces: { AB: this.forces.AB, BC: this.forces.BC },
        vibrationMmS: this.vibrationMmS,
        fault: this.fault ? {
          code: this.fault.code, message: this.fault.message,
          t: this.fault.t, step: this.fault.step
        } : null
      };
    }
  }

  /* ---------------- 无头运行辅助（供 Node 验证与页面自测共用） ---------------- */
  function runScenario(cfg, durationMs) {
    const sim = new GearboxSim(cfg);
    const nSteps = Math.round((durationMs || 60000) / 1000 / DT);
    let last = sim.snapshot();
    for (let i = 0; i < nSteps && !sim.fault; i++) last = sim.step();
    return {
      config: JSON.parse(JSON.stringify(cfg)),
      geom: sim.geom,
      fault: sim.fault,
      final: last,
      trigger: sim.fault ? sim.fault.snap : null,
      recorder: sim.recorder,
      expectedOutputRpm: expectedOutputRpm(cfg)
    };
  }

  const API = {
    GearboxSim, runScenario, evaluateMeshes, expectedOutputRpm,
    pitchRadiusMM, gearInertia, makeRng,
    GEAR_TEETH_CHOICES, LIMITS, DT, RECORD_EVERY,
    SHAFT_DIST_MM, MESH_TOL_MM, MODULE_MM, DEFAULT_SEED
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.GearboxPhysics = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
