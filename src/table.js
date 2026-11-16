// 球桌几何：库边/袋角线段 + 袋口。坐标原点在台面左下角，单位米。
import {
  PLAY_W, PLAY_H, BALL_R,
  POCKET_CORNER_CAPTURE, POCKET_SIDE_CAPTURE, POCKET_VISUAL_R,
  JAW_INSET, SIDE_GAP, JAW_INNER, JAW_DEPTH,
} from './constants.js';

const W = PLAY_W;
const H = PLAY_H;
const MX = W / 2;

// 每条线段带朝台面内的法向量
function seg(ax, ay, bx, by) {
  let nx = -(by - ay);
  let ny = bx - ax;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l; ny /= l;
  // 确保法线指向台面中心一侧
  const mx2 = (ax + bx) / 2;
  const my2 = (ay + by) / 2;
  if (nx * (MX - mx2) + ny * (H / 2 - my2) < 0) {
    nx = -nx; ny = -ny;
  }
  return { ax, ay, bx, by, nx, ny };
}

export function buildTable() {
  const segments = [];
  const pockets = [];

  // —— 四条主库边（中袋与角袋开口处断开）——
  segments.push(seg(JAW_INSET, 0, MX - SIDE_GAP, 0));
  segments.push(seg(MX + SIDE_GAP, 0, W - JAW_INSET, 0));
  segments.push(seg(JAW_INSET, H, MX - SIDE_GAP, H));
  segments.push(seg(MX + SIDE_GAP, H, W - JAW_INSET, H));
  segments.push(seg(0, JAW_INSET, 0, H - JAW_INSET));
  segments.push(seg(W, JAW_INSET, W, H - JAW_INSET));

  // 漏斗袋角：线段面平行于「袋角外端->袋心」的进袋方向，
  // 球擦上后被导向袋心。法线指向 V 形槽内侧。
  function funnel(ax, ay, bx, by, nx, ny, pocket) {
    const s = seg(ax, ay, bx, by);
    const l = Math.hypot(nx, ny) || 1;
    s.nx = nx / l;
    s.ny = ny / l;
    s.jaw = true;
    s.pocket = pocket;
    segments.push(s);
  }

  // —— 角袋袋角（V 形漏斗，两颊平行于进袋对角线）——
  const J = JAW_INSET, JI = JAW_INNER, JD = JAW_DEPTH;
  const BL = { x: 0, y: 0 }, BR = { x: W, y: 0 }, TL = { x: 0, y: H }, TR = { x: W, y: H };
  // 左下
  funnel(J, 0, JI, JD, 1, 1, BL);
  funnel(0, J, JD, JI, 1, 1, BL);
  // 右下
  funnel(W - J, 0, W - JI, JD, -1, 1, BR);
  funnel(W, J, W - JD, JI, -1, 1, BR);
  // 左上
  funnel(J, H, JI, H - JD, 1, -1, TL);
  funnel(0, H - J, JD, H - JI, 1, -1, TL);
  // 右上
  funnel(W - J, H, W - JI, H - JD, -1, -1, TR);
  funnel(W, H - J, W - JD, H - JI, -1, -1, TR);

  // —— 中袋袋角（V 形漏斗，法线斜指袋心）——
  const SB = { x: MX, y: 0 }, ST = { x: MX, y: H };
  funnel(MX - SIDE_GAP, 0, MX - JI, JD, 0.45, 1, SB);
  funnel(MX + SIDE_GAP, 0, MX + JI, JD, -0.45, 1, SB);
  funnel(MX - SIDE_GAP, H, MX - JI, H - JD, 0.45, -1, ST);
  funnel(MX + SIDE_GAP, H, MX + JI, H - JD, -0.45, -1, ST);

  // —— 袋口 ——
  const corner = (x, y) => pockets.push({ x, y, r: POCKET_CORNER_CAPTURE, visualR: POCKET_VISUAL_R, side: false });
  corner(0, 0);
  corner(W, 0);
  corner(0, H);
  corner(W, H);
  pockets.push({ x: MX, y: 0, r: POCKET_SIDE_CAPTURE, visualR: POCKET_VISUAL_R, side: true });
  pockets.push({ x: MX, y: H, r: POCKET_SIDE_CAPTURE, visualR: POCKET_VISUAL_R, side: true });

  return { segments, pockets, W, H, ballR: BALL_R };
}

// 球是否被袋口捕获：进入捕获圆即判进。
// 捕获圆位于台面角/边之外，台面内部的球与袋心的距离天然大于捕获半径，
// 因此不会出现远距离被吸入；擦袋角的球沿 V 形漏斗滑入后自然落入。
export function checkPocketCapture(table, ball) {
  for (const p of table.pockets) {
    const d = Math.hypot(ball.x - p.x, ball.y - p.y);
    if (d <= p.r) return p;
  }
  return null;
}
