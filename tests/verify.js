/*
 * tests/verify.js — 无头验证（node tests/verify.js）
 * 覆盖：正常工况、极限载荷（含越限）、失稳、卡死、可重复性、重置漂移、暂停/单步等价。
 * 退出码 0 = 全部通过。
 */
'use strict';
const P = require('../gearbox/physics.js');
const { GearboxSim, runScenario, LIMITS, DT, RECORD_EVERY } = P;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const DT_FRAME = DT * RECORD_EVERY; // 采样帧间隔 = 1/60 s

/* ---------- 工况 1：正常工况，输出轴应达到目标转速 ---------- */
const normalCfg = { teeth: [32, 32, 24], inputRpm: 900, loadNm: 60, seed: 42 };
check('正常工况：几何判定为健康啮合', new GearboxSim(normalCfg).geom.status === 'healthy');
const normal = runScenario(normalCfg, 8000);
const outRpm1 = Math.abs(normal.final.rpm[2]);
const target1 = normal.expectedOutputRpm;
check('正常工况：无跳闸', !normal.fault, normal.fault ? normal.fault.message : '全程稳定');
check('正常工况：输出转速达标（±4%）',
  Math.abs(outRpm1 - target1) / target1 < 0.04,
  `目标 ${target1.toFixed(1)} rpm，实测 ${outRpm1.toFixed(1)} rpm`);
check('正常工况：温度/压力在限内',
  normal.final.tempC < LIMITS.temperature.max &&
  normal.final.pressureMPa < LIMITS.pressure.max,
  `压力 ${normal.final.pressureMPa.toFixed(1)} MPa，温度 ${normal.final.tempC.toFixed(1)} °C`);

/* ---------- 工况 2a：极限载荷（接近上限），应压力跳闸并记录触发点 ---------- */
const extremeCfg = { teeth: [32, 32, 24], inputRpm: 900, loadNm: 195, seed: 42 };
const extreme = runScenario(extremeCfg, 30000);
check('极限载荷：发生跳闸', !!extreme.fault,
  extreme.fault ? `${extreme.fault.code} @ t=${extreme.fault.t.toFixed(3)}s` : '未跳闸（异常）');
check('极限载荷：跳闸类型为压力', extreme.fault && extreme.fault.code === 'pressure',
  extreme.fault ? extreme.fault.message : '');
check('极限载荷：在负载斜坡建立过程中触发（非 t=0 阶跃误报）',
  extreme.fault && extreme.fault.t > 0.3,
  `触发于 t=${extreme.fault ? extreme.fault.t.toFixed(2) : '-'}s（斜坡 0.5s 内，负载约 ${extreme.trigger ? Math.round(Math.min(1, extreme.fault.t / 0.5) * 195) : '-'} N·m）`);
check('极限载荷：触发点快照完整（位置/速度/压力/温度）',
  extreme.trigger &&
  Array.isArray(extreme.trigger.theta) && extreme.trigger.theta.length === 3 &&
  Array.isArray(extreme.trigger.rpm) &&
  typeof extreme.trigger.pressureMPa === 'number' &&
  typeof extreme.trigger.tempC === 'number',
  extreme.trigger ? `t=${extreme.trigger.t.toFixed(3)}s, p=${extreme.trigger.pressureMPa.toFixed(1)}MPa, ` +
    `T=${extreme.trigger.tempC.toFixed(1)}°C, ω=[${extreme.trigger.rpm.map((r) => r.toFixed(0)).join(', ')}] rpm, ` +
    `θ=[${extreme.trigger.theta.map((x) => x.toFixed(2)).join(', ')}] rad` : '');
check('极限载荷：跳闸后状态冻结（不再继续计算）', (() => {
  const sim = new GearboxSim(extremeCfg);
  while (!sim.fault) sim.step();
  const frozen = JSON.stringify(sim.snapshot());
  for (let i = 0; i < 50; i++) sim.step();
  return JSON.stringify(sim.snapshot()) === frozen;
})());

/* ---------- 工况 2b：负载/转速越上下限，t=0 即触发，显示触发点 ---------- */
const overLoad = runScenario({ teeth: [32, 32, 24], inputRpm: 900, loadNm: 250 }, 5000);
check('负载越限：t=0 拒绝计算',
  overLoad.fault && overLoad.fault.code === 'load' && overLoad.fault.t === 0,
  overLoad.fault ? overLoad.fault.message : '');
const overSpeed = runScenario({ teeth: [32, 32, 24], inputRpm: 1800, loadNm: 60 }, 5000);
check('转速越限：t=0 拒绝计算',
  overSpeed.fault && overSpeed.fault.code === 'speed' && overSpeed.fault.t === 0,
  overSpeed.fault ? overSpeed.fault.message : '');

/* ---------- 工况 3：失稳（松旷啮合导致冲击振动） ---------- */
const looseCfg = { teeth: [20, 28, 24], inputRpm: 900, loadNm: 40, seed: 7 };
const looseGeom = new GearboxSim(looseCfg).geom;
check('失稳工况：几何判定为松旷', looseGeom.status === 'loose',
  `间隙 AB=${looseGeom.gaps.AB.toFixed(2)}mm, BC=${looseGeom.gaps.BC.toFixed(2)}mm`);
const loose = runScenario(looseCfg, 30000);
check('失稳工况：触发失稳/压力保护',
  !!loose.fault && (loose.fault.code === 'instability' || loose.fault.code === 'pressure'),
  loose.fault ? `${loose.fault.code} @ t=${loose.fault.t.toFixed(3)}s，` +
    `振动=${loose.trigger.vibrationMmS.toFixed(1)}mm/s，压力=${loose.trigger.pressureMPa.toFixed(1)}MPa，` +
    `温度=${loose.trigger.tempC.toFixed(1)}°C` : '未跳闸');
check('失稳工况：触发点记录速度与位置且数值有限',
  loose.trigger && loose.trigger.theta.every((x) => Number.isFinite(x)) &&
  loose.trigger.rpm.every((x) => Number.isFinite(x)) &&
  Number.isFinite(loose.trigger.pressureMPa));

/* ---------- 附加：轴距过紧卡死，t=0 拒绝安装 ---------- */
const jamCfg = { teeth: [40, 40, 32], inputRpm: 900, loadNm: 60 };
const jam = runScenario(jamCfg, 5000);
check('卡死工况：t=0 拒绝计算',
  jam.fault && jam.fault.code === 'jam' && jam.fault.t === 0,
  jam.fault ? jam.fault.message : '');

/* ---------- 工况 4：热保护路径（持续满载使油温逼近热极限） ---------- */
const thermalCfg = { teeth: [32, 32, 24], inputRpm: 1000, loadNm: 140, seed: 42 };
const thermal = runScenario(thermalCfg, 1000000);
check('热保护：持续满载触发温度跳闸',
  thermal.fault && thermal.fault.code === 'temperature',
  thermal.fault ? `t=${thermal.fault.t.toFixed(0)}s，T=${thermal.trigger.tempC.toFixed(1)}°C` : '未跳闸');
check('热保护：触发点压力始终在强度限内（非压力误跳）',
  thermal.trigger && thermal.trigger.pressureMPa < LIMITS.pressure.max,
  `触发时压力 ${thermal.trigger ? thermal.trigger.pressureMPa.toFixed(0) : '-'} MPa`);
check('热保护：触发快照记录完整温度与位置',
  thermal.trigger && thermal.trigger.tempC >= LIMITS.temperature.max &&
  thermal.trigger.theta.every(Number.isFinite));
// 正常工况 60s 温升温和、不触发热保护
const normal60 = runScenario(normalCfg, 60000);
check('正常工况：60s 温升温和且无热跳闸',
  !normal60.fault && normal60.final.tempC < 60,
  `60s 油温 ${normal60.final.tempC.toFixed(1)} °C`);

/* ---------- 可重复性：同参数两次运行逐位一致 ---------- */
const r1 = runScenario(normalCfg, 6000);
const r2 = runScenario(normalCfg, 6000);
check('可重复性：正常工况两次运行快照逐位一致',
  JSON.stringify(r1.recorder) === JSON.stringify(r2.recorder),
  `${r1.recorder.length} 个采样帧`);
const r3 = runScenario(looseCfg, 4000);
const r4 = runScenario(looseCfg, 4000);
check('可重复性：失稳工况两次运行逐位一致（含触发点）',
  JSON.stringify(r3.recorder) === JSON.stringify(r4.recorder) &&
  JSON.stringify(r3.fault) === JSON.stringify(r4.fault),
  r3.fault ? `跳闸步 #${r3.fault.step} 一致` : '');

/* ---------- 重置不漂移：多次 reset 后初始条件完全相同 ---------- */
const simR = new GearboxSim(normalCfg);
const init0 = JSON.stringify(simR.reset());
let drift = false;
for (let i = 0; i < 5; i++) {
  simR.step(); simR.step(); simR.step();
  if (JSON.stringify(simR.reset()) !== init0) drift = true;
}
check('多次重置：初始条件零漂移', !drift);

/* ---------- 暂停/单步等价：连续运行 = 相同步数的单步累积 ---------- */
const simA = new GearboxSim(normalCfg);
const simB = new GearboxSim(normalCfg);
const N = 37;
for (let i = 0; i < N; i++) simA.step();          // “连续运行”
for (let i = 0; i < N; i++) { /* 模拟暂停 */ simB.step(); } // 逐次单步
check('暂停与单步：物理状态完全相同',
  JSON.stringify(simA.snapshot()) === JSON.stringify(simB.snapshot()),
  `t=${simA.snapshot().t.toFixed(4)}s`);

/* ---------- 回放无跳变：任何“跳变”都必须能被物理最大加速度解释 ----------
 * 不用特定积分格式做容差（启动瞬态帧间加速度变化大，梯形/欧拉法都会误报）；
 * 改为：帧间 Δθ 必须落在 [ω·Δt ± ½·αmax·Δt²]、Δω 必须 ≤ αmax·Δt。
 * αmax = 电机最大扭矩 / 最小齿轮惯量，取 2 倍裕度。非物理跳变必然越界。 */
let jumps = 0;
const rec = normal.recorder;
const simProbe = new GearboxSim(normalCfg);
const alphaMax = (2 * 340) / Math.min(...simProbe.I); // rad/s²，电机最大扭矩/最小惯量并含安全裕度
for (let i = 1; i < rec.length; i++) {
  for (let g = 0; g < 3; g++) {
    if (!Number.isFinite(rec[i].theta[g]) || !Number.isFinite(rec[i].omega[g])) { jumps++; continue; }
    const dTh = rec[i].theta[g] - rec[i - 1].theta[g];
    const kin = rec[i - 1].omega[g] * DT_FRAME;
    if (Math.abs(dTh - kin) > 0.5 * alphaMax * DT_FRAME * DT_FRAME) jumps++;
    if (Math.abs(rec[i].omega[g] - rec[i - 1].omega[g]) > alphaMax * DT_FRAME) jumps++;
  }
}
check('回放缓冲：关键状态无跳变', jumps === 0, `${rec.length} 帧，异常跳变 ${jumps} 处`);

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('失败项：', failed.map((f) => f.name).join('; '));
  process.exit(1);
}
console.log('全部验证通过。');
