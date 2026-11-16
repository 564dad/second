// 全局物理与尺寸常量。距离单位：米；质量单位：千克。

export const BALL_R = 0.028575;          // 美式台球半径（直径 57.15mm）
export const BALL_M = 0.17;              // 质量（取值不影响无量纲结果）
export const BALL_I = (2 / 5) * BALL_M * BALL_R * BALL_R; // 实心球转动惯量

// 台面（库边内侧）尺寸，约 2:1
export const PLAY_W = 2.24;
export const PLAY_H = 1.12;

// 摩擦
export const MU_SLIDE = 0.22;            // 滑动摩擦系数（布面对球）
export const ROLL_DECEL = 0.85;          // 纯滚动阻力减速度 m/s^2
export const SPIN_DECEL = 1.4;           // 绕竖直轴自转（塞）的衰减 rad/s^2
export const G = 9.81;

// 碰撞恢复系数
export const REST_BALL = 0.96;           // 球-球
export const REST_CUSHION = 0.80;        // 球-库边（法向能量损耗）
export const MU_CUSHION = 0.55;          // 库边切向摩擦（塞改变反射角的来源）
export const MU_BALL_T = 0.05;           // 球-球切向摩擦（投掷效应）

// 停稳阈值（迟滞：进入后直接清零，杜绝来回抖）
export const STOP_V = 0.045;             // m/s
export const STOP_W = 1.2;               // rad/s（滚动分量）
export const STOP_WZ = 0.8;              // rad/s（竖直自转）

// 出杆
export const MAX_CUE_SPEED = 8.5;        // 满力母球初速 m/s
export const DT_FIXED = 1 / 300;         // 物理固定步长
export const MAX_STEPS_PER_FRAME = 24;   // 防止螺旋掉帧

// 袋口（以球半径为基准，接近真实比例：角袋口约 115mm，中袋约 130mm）
export const POCKET_CORNER_CAPTURE = 2.05 * BALL_R;
export const POCKET_SIDE_CAPTURE = 2.15 * BALL_R;
export const POCKET_VISUAL_R = 2.0 * BALL_R;
export const JAW_INSET = 0.065;          // 袋角外端离台角距离（决定袋口开度）
export const SIDE_GAP = 0.065;           // 中袋两侧袋角离中线距离
export const JAW_INNER = 0.026;          // 袋角内端离边距离
export const JAW_DEPTH = 0.026;          // 袋角内端探入台面的深度

export const BALL_COLORS = {
  1: '#f6c33b', 2: '#2c5fbf', 3: '#d8403a', 4: '#7a3fb0',
  5: '#e87b2a', 6: '#2f8a4e', 7: '#8c2327', 8: '#161616',
  9: '#f6c33b', 10: '#2c5fbf', 11: '#d8403a', 12: '#7a3fb0',
  13: '#e87b2a', 14: '#2f8a4e', 15: '#8c2327',
};
