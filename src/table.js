// table.js — 台面几何布局（逻辑正交坐标系，单位 px；投影只在渲染层做）
// 逻辑台面 720 x 1080 竖屏，y 向下为正，重力 +y。
import { vec } from './vec.js';

export const TABLE = {
  W: 720,
  H: 1080,
  BALL_R: 11,
  GRAVITY: 1500,
  MAX_SPEED: 3300,
};

// 发射器通道（右侧）
export const PLUNGER = {
  x0: 648,            // 通道左墙 x
  x1: 700,            // 台面右边界
  restY: 980,         // 球静止位
  minLaunch: 900,
  maxLaunch: 3050,    // 蓄力满 -> 3050 px/s，满足 3000 档验收
  chargeTime: 1.1,    // 充满所需秒数
};

// 挡板（胶囊：pivot + len + 半径），角度单位弧度，0 = 水平向右，正角向下
export const FLIPPERS = [
  {
    id: 'L',
    pivot: vec(232, 932),
    len: 118,
    r: 13,
    restAng: 0.46,         // 静止：尖端下沉约 26°
    activeAng: -0.52,      // 激活：抬起约 -30°
    omega: 26,             // 角速度 rad/s（动画与物理都用它，非瞬移）
    side: -1,
  },
  {
    id: 'R',
    pivot: vec(488, 932),
    len: 118,
    r: 13,
    restAng: Math.PI - 0.46,
    activeAng: Math.PI + 0.52,
    omega: 26,
    side: 1,
  },
];

// 三个弹力柱（pop bumpers）：击中给固定冲量
export const BUMPERS = [
  { id: 'b1', pos: vec(360, 560), r: 34, kick: 620, score: 150 },
  { id: 'b2', pos: vec(268, 648), r: 34, kick: 620, score: 150 },
  { id: 'b3', pos: vec(452, 648), r: 34, kick: 620, score: 150 },
];

// 两侧斜向金属导轨（线段墙，低弹性 -> 把球顺出去而不是弹回来）
export const RAILS = [
  { id: 'railL', a: vec(96, 556), b: vec(176, 716), r: 8 },
  { id: 'railR', a: vec(624, 556), b: vec(544, 716), r: 8 },
];

// 弹弓护圈（slingshots，静态倾斜墙，带轻微踢力）
export const SLINGSHOTS = [
  { id: 'slingL', a: vec(150, 828), b: vec(214, 760), r: 7, kick: 260 },
  { id: 'slingR', a: vec(570, 828), b: vec(506, 760), r: 7, kick: 260 },
];

// 靶子（圆环）：金色三个一组 = multiball 组；青色散靶
export const TARGETS = [
  // multiball 组（全部点亮触发第二球）
  { id: 't1', pos: vec(196, 268), r: 17, color: 'amber', group: 'mb', score: 100 },
  { id: 't2', pos: vec(360, 206), r: 17, color: 'amber', group: 'mb', score: 100 },
  { id: 't3', pos: vec(524, 152), r: 17, color: 'amber', group: 'mb', score: 100 },
  // 散靶
  { id: 't4', pos: vec(140, 418), r: 16, color: 'cyan', group: null, score: 120 },
  { id: 't5', pos: vec(580, 336), r: 16, color: 'cyan', group: null, score: 120 },
  { id: 't6', pos: vec(196, 760), r: 15, color: 'cyan', group: null, score: 120 },
  { id: 't7', pos: vec(524, 760), r: 15, color: 'cyan', group: null, score: 120 },
  { id: 't8', pos: vec(360, 824), r: 15, color: 'cyan', group: null, score: 120 },
];

// 墙体（线段）：外框、发射通道、顶部引导弧、底部围裙、回球通道
// restitution 各自不同
function seg(id, ax, ay, bx, by, r = 6, e = 0.45) {
  return { id, a: vec(ax, ay), b: vec(bx, by), r, e };
}

export const WALLS = [
  // 左外框
  seg('wallL', 24, 60, 24, 1000, 7, 0.5),
  seg('wallLT', 24, 60, 96, 36, 7, 0.5),
  seg('wallTop', 96, 36, 648, 36, 7, 0.5),
  // 发射通道：左墙在 y96~290 留贯通台面的出球缝
  seg('plungerL_mid', 648, 290, 648, 760, 6, 0.35),
  seg('plungerL_low', 648, 838, 648, 952, 6, 0.35),
  seg('plungerR', 700, 100, 700, 1010, 7, 0.4),
  // 槽顶两段式弧形弯轨：把竖直上冲平滑掰成向左，经出球缝进入台面
  seg('laneHook1', 688, 60, 700, 100, 7, 0.55),
  seg('laneHook2', 650, 96, 688, 60, 7, 0.55),
  // 出球缝下沿倒角：把擦边的球顺出台面而不是挡回槽里
  seg('laneChamfer', 648, 290, 620, 268, 6, 0.3),
  // 底部外框
  seg('floorL', 24, 1000, 118, 1000, 7, 0.35),
  seg('floorR', 602, 1000, 700, 1010, 7, 0.35),
  // 左右回球斜墙（外侧 outlane -> 排水口）
  seg('outL', 24, 880, 118, 1000, 7, 0.3),
  seg('outR', 648, 880, 602, 1000, 7, 0.3),
  // 中央围裙（尖顶朝上，不留平底卡球；球被分到两侧口）
  seg('apronL', 360, 980, 250, 1002, 7, 0.25),
  seg('apronR', 360, 980, 470, 1002, 7, 0.25),
  // 挡板外侧挡块（挡板与 outlane 之间的小斜面）
  seg('stopL', 118, 880, 196, 880, 7, 0.35),
  seg('stopR', 524, 880, 602, 880, 7, 0.35),
];

// 排水口（掉进去丢一条命）：两个矩形感应区
export const DRAINS = [
  { id: 'drainL', x: 120, y: 1004, w: 128, h: 40 },
  { id: 'drainR', x: 472, y: 1004, w: 128, h: 40 },
];

// 连击窗口
export const COMBO_WINDOW = 2.2;

/** 取挡板当前世界胶囊端点与端点速度 */
export function flipperGeometry(f) {
  const tip = {
    x: f.pivot.x + Math.cos(f.ang) * f.len,
    y: f.pivot.y + Math.sin(f.ang) * f.len,
  };
  // 刚体绕 pivot 旋转：v = ω × r（2D: v = ω * perp(r)）
  const omega = f.angVel || 0;
  const vPivot = vec(0, 0);
  const rTip = { x: tip.x - f.pivot.x, y: tip.y - f.pivot.y };
  const vTip = { x: -omega * rTip.y, y: omega * rTip.x };
  return { a: { ...f.pivot }, b: tip, va: vPivot, vb: vTip };
}

/** 挡板上距球最近点处的表面线速度（线性插值 ω×r） */
export function flipperSurfaceVelocity(f, contactPoint) {
  const omega = f.angVel || 0;
  const r = { x: contactPoint.x - f.pivot.x, y: contactPoint.y - f.pivot.y };
  return { x: -omega * r.y, y: omega * r.x };
}
