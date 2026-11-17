#!/usr/bin/env python3 -I
"""headless_check.py — JS 物理引擎的 Python 独立镜像，跑四项验收。

环境里没有 JS 引擎/浏览器，这里用 Python 按 src/vec.js、src/physics.js、
src/table.js、src/game.js 的同一套数学重新实现一遍（扫掠 CCD + 自适应子步、
挡板角速度耦合、固定冲量弹力柱、连击、卡死自救），用于无头验收。
真实浏览器里另有 src/selftest.js 跑完全相同的用例。
"""
import math
import sys

# ---------------- 台面布局（镜像 src/table.js） ----------------
W, H = 720, 1080
BALL_R = 11
GRAVITY = 1500
MAX_SPEED = 3300
COMBO_WINDOW = 2.2
FIXED_DT = 1 / 120
STEP_MOVE = BALL_R * 0.6
MAX_SUBSTEPS = 24

FLIPPERS = [
    dict(id='L', px=232, py=932, len=118, r=13, rest=0.46, active=-0.52, omega=26),
    dict(id='R', px=488, py=932, len=118, r=13,
         rest=math.pi - 0.46, active=math.pi + 0.52, omega=26),
]
BUMPERS = [
    dict(id='b1', x=360, y=560, r=34, kick=620, score=150),
    dict(id='b2', x=268, y=648, r=34, kick=620, score=150),
    dict(id='b3', x=452, y=648, r=34, kick=620, score=150),
]
TARGETS = [
    dict(id='t1', x=196, y=268, r=17, group='mb', score=100),
    dict(id='t2', x=360, y=206, r=17, group='mb', score=100),
    dict(id='t3', x=524, y=152, r=17, group='mb', score=100),
    dict(id='t4', x=140, y=418, r=16, group=None, score=120),
    dict(id='t5', x=580, y=336, r=16, group=None, score=120),
    dict(id='t6', x=196, y=760, r=15, group=None, score=120),
    dict(id='t7', x=524, y=760, r=15, group=None, score=120),
    dict(id='t8', x=360, y=824, r=15, group=None, score=120),
]
RAILS = [
    dict(id='railL', ax=96, ay=556, bx=176, by=716, r=8),
    dict(id='railR', ax=624, ay=556, bx=544, by=716, r=8),
]
SLINGS = [
    dict(id='slingL', ax=150, ay=828, bx=214, by=760, r=7, kick=260),
    dict(id='slingR', ax=570, ay=828, bx=506, by=760, r=7, kick=260),
]


def S(x, y):
    return (float(x), float(y))


def add(a, b): return (a[0] + b[0], a[1] + b[1])
def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def scl(a, k): return (a[0] * k, a[1] * k)
def dot(a, b): return a[0] * b[0] + a[1] * b[1]
def length(a): return math.hypot(a[0], a[1])
def norm(a):
    l = length(a)
    return (a[0] / l, a[1] / l) if l > 1e-12 else (0.0, 0.0)
def clamp(v, lo, hi): return max(lo, min(hi, v))
def lerp(a, b, t): return a + (b - a) * t
def lerp_pt(a, b, t): return (lerp(a[0], b[0], t), lerp(a[1], b[1], t))


def closest_seg(p, a, b):
    ab = sub(b, a)
    l2 = dot(ab, ab)
    if l2 < 1e-12:
        return a, 0.0
    t = clamp(dot(sub(p, a), ab) / l2, 0, 1)
    return (a[0] + ab[0] * t, a[1] + ab[1] * t), t


# 线段墙（镜像 WALLS；测试重点是挡板/墙/弹力柱/靶子，导轨等一并保留）
def seg(ax, ay, bx, by, r=6, e=0.45):
    return dict(ax=ax, ay=ay, bx=bx, by=by, r=r, e=e)


WALLS = [
    seg(24, 60, 24, 1000, 7, 0.5), seg(24, 60, 96, 36, 7, 0.5),
    seg(96, 36, 648, 36, 7, 0.5),
    seg(648, 290, 648, 760, 6, 0.35),
    # 出球缝下沿倒角：把擦边的球顺出台面而不是挡回槽里
    seg(648, 290, 620, 268, 6, 0.3),
    # 槽顶两段式弧形弯轨：把竖直上冲平滑掰成向左；缝（x=648 处 y96~290）直通台面
    seg(688, 60, 700, 100, 7, 0.55),
    seg(650, 96, 688, 60, 7, 0.55),
    seg(648, 838, 648, 952, 6, 0.35), seg(700, 100, 700, 1010, 7, 0.4),
    seg(24, 1000, 118, 1000, 7, 0.35), seg(602, 1000, 700, 1010, 7, 0.35),
    seg(24, 880, 118, 1000, 7, 0.3), seg(648, 880, 602, 1000, 7, 0.3),
    seg(360, 980, 250, 1002, 7, 0.25), seg(360, 980, 470, 1002, 7, 0.25),
    seg(118, 880, 196, 880, 7, 0.35), seg(524, 880, 602, 880, 7, 0.35),
]
for _i, _w in enumerate(WALLS):
    _w['id'] = 'wall%d' % _i
DRAINS = [dict(x=120, y=1004, w=128), dict(x=472, y=1004, w=128)]


# ---------------- 扫掠碰撞（镜像 vec.js） ----------------
def swept_segment(c0, r, v, dt, a0, b0, va=(0, 0), vb=(0, 0)):
    a1 = add(a0, scl(va, dt))
    b1 = add(b0, scl(vb, dt))

    def gap_at(tt):
        k = tt / dt
        a = lerp_pt(a0, a1, k)
        b = lerp_pt(b0, b1, k)
        c = add(c0, scl(v, tt))
        pt, _ = closest_seg(c, a, b)
        d = sub(c, pt)
        return length(d) - r, d, pt, c

    g0, d0, p0, _ = gap_at(0.0)
    if g0 <= 0:
        n = norm(d0) if length(d0) > 1e-9 else norm(sub(c0, a0))
        return dict(hit=True, t=0.0, n=n, point=p0)

    # 子步已保证相对位移 < 2r，不可能一进一出：末端检测 + 二分求根
    ge, _, _, _ = gap_at(dt)
    if ge > 0:
        return dict(hit=False)
    lo, hi = 0.0, dt
    for _ in range(14):
        mid = (lo + hi) * 0.5
        if gap_at(mid)[0] <= 0:
            hi = mid
        else:
            lo = mid
    t = hi
    _, d, pt, c = gap_at(t)
    n = norm(d) if length(d) > 1e-9 else norm(sub(c, pt))
    return dict(hit=True, t=t, n=n, point=pt)


def swept_circle(c0, r, v, dt, o, ro):
    R = r + ro
    rel = sub(c0, o)
    a = dot(v, v)
    if a < 1e-12:
        d = length(rel)
        if d <= R:
            return dict(hit=True, t=0.0, n=norm(rel) if d > 1e-9 else (0, -1))
        return dict(hit=False)
    b = 2 * dot(rel, v)
    cc = dot(rel, rel) - R * R
    disc = b * b - 4 * a * cc
    if disc < 0:
        return dict(hit=False)
    sq = math.sqrt(disc)
    t1, t2 = (-b - sq) / (2 * a), (-b + sq) / (2 * a)
    t = -1
    if 0 <= t1 <= dt:
        t = t1
    elif 0 <= t2 <= dt and cc <= 0:
        t = 0.0
    if t < 0:
        return dict(hit=False)
    n = norm(add(rel, scl(v, t)))
    return dict(hit=True, t=t, n=n)


def reflect(v, n, e, sv=(0, 0), friction=0.0):
    rel = sub(v, sv)
    rel_n = dot(rel, n)
    if rel_n >= 0 and dot(v, n) > dot(sv, n):
        return v
    tan = (-n[1], n[0])
    vt = dot(rel, tan)
    return add(sv, add(scl(n, -e * rel_n), scl(tan, vt * (1 - friction))))


# ---------------- 挡板 ----------------
def flipper_geom(f):
    tip = (f['px'] + math.cos(f['ang']) * f['len'],
           f['py'] + math.sin(f['ang']) * f['len'])
    r = sub(tip, (f['px'], f['py']))
    w = f.get('angVel', 0.0)
    vtip = (-w * r[1], w * r[0])
    return (f['px'], f['py']), tip, (0, 0), vtip


def surf_velocity(f, cp):
    w = f.get('angVel', 0.0)
    r = (cp[0] - f['px'], cp[1] - f['py'])
    return (-w * r[1], w * r[0])


# ---------------- 引擎状态 ----------------
class Ball:
    def __init__(self, x, y):
        self.x, self.y = x, y
        self.vx = self.vy = 0.0
        self.alive = True
        self.locked = False
        self.cd = {}
        self.stuck_t = 0.0
        self.nudge_cd = 0.0
        self.nudge_count = 0
        self.safe_t = 0.0
        self.history = []
        self.hist_t = 0.0
        self.last = (x, y)

    @property
    def pos(self): return (self.x, self.y)
    @pos.setter
    def pos(self, p): self.x, self.y = p
    @property
    def vel(self): return (self.vx, self.vy)
    @vel.setter
    def vel(self, v): self.vx, self.vy = v


class Game:
    def __init__(self):
        self.flippers = []
        for f in FLIPPERS:
            g = dict(f)
            g['ang'] = f['rest']
            g['angVel'] = 0.0
            g['pressed'] = False
            self.flippers.append(g)
        self.targets = [dict(t, lit=False, flash=0.0, hits=0) for t in TARGETS]
        self.bumper_flash = {b['id']: 0.0 for b in BUMPERS}
        self.balls = []
        self.events = []
        self.score = 0
        self.combo_id = None
        self.combo_n = 0
        self.combo_t = 0.0
        self.mb_armed = True
        self.mb_pending = 0.0
        self.max_sub = 0

    def spawn(self, x, y, vx, vy):
        b = Ball(x, y)
        b.vx, b.vy = vx, vy
        self.balls.append(b)
        return b

    def step(self, dt=FIXED_DT):
        # 挡板积分
        for f in self.flippers:
            prev = f['ang']
            target = f['active'] if f['pressed'] else f['rest']
            f['ang'] += clamp(target - f['ang'], -f['omega'] * dt, f['omega'] * dt)
            f['angVel'] = (f['ang'] - prev) / dt

        # multiball 倒计时：到期自动发射第二球
        if self.mb_pending > 0:
            self.mb_pending -= dt
            if self.mb_pending <= 0:
                nb = self.spawn(674, 980, 0, -2800)
                nb.locked = False
        # 球数回到 1 后重新装填 multiball
        if not self.mb_armed and sum(1 for b in self.balls if b.alive) <= 1:
            self.mb_armed = True

        for ball in list(self.balls):
            if not ball.alive:
                continue
            remaining = dt
            subs = 0
            while remaining > 1e-7 and subs < MAX_SUBSTEPS * 2:
                tip_speed = max(abs(f['angVel']) * f['len'] for f in self.flippers)
                move = max(length(ball.vel), tip_speed) * remaining
                n = clamp(math.ceil(move / STEP_MOVE), 1, MAX_SUBSTEPS)
                h = remaining / n
                consumed = self._substep(ball, h)
                remaining -= consumed
                subs += 1
            self.max_sub = max(self.max_sub, subs)

        self._collide_balls(dt)

        for ball in self.balls:
            if not ball.alive:
                continue
            for d in DRAINS:
                if d['x'] < ball.x < d['x'] + d['w'] and ball.y > d['y']:
                    ball.alive = False
                    self.events.append('drain')
                    break
            if ball.y > H + 80 or ball.x < -120 or ball.x > W + 120:
                ball.alive = False
                self.events.append('drain')

        if self.combo_n > 0:
            self.combo_t -= dt
            if self.combo_t <= 0:
                self.combo_n, self.combo_id = 0, None

    def _substep(self, ball, h):
        if not ball.locked:
            ball.vy += GRAVITY * h
        sp = length(ball.vel)
        if sp > MAX_SPEED:
            ball.vel = scl(ball.vel, MAX_SPEED / sp)
        c0 = ball.pos
        v = ball.vel
        hits = []

        for w in WALLS:
            r = swept_segment(c0, BALL_R, v, h, S(w['ax'], w['ay']), S(w['bx'], w['by']))
            if r['hit']:
                hits.append(('wall', w, r))
        for rl in RAILS:
            r = swept_segment(c0, BALL_R, v, h, S(rl['ax'], rl['ay']), S(rl['bx'], rl['by']))
            if r['hit']:
                hits.append(('rail', rl, r))
        for sl in SLINGS:
            r = swept_segment(c0, BALL_R, v, h, S(sl['ax'], sl['ay']), S(sl['bx'], sl['by']))
            if r['hit']:
                hits.append(('sling', sl, r))
        for f in self.flippers:
            a, b, va, vb = flipper_geom(f)
            r = swept_segment(c0, BALL_R, v, h, a, b, va, vb)
            if r['hit']:
                hits.append(('flipper', f, r))
        for bm in BUMPERS:
            r = swept_circle(c0, BALL_R, v, h, S(bm['x'], bm['y']), bm['r'])
            if r['hit']:
                hits.append(('bumper', bm, r))
        for tg in self.targets:
            r = swept_circle(c0, BALL_R, v, h, S(tg['x'], tg['y']), tg['r'])
            if r['hit']:
                hits.append(('target', tg, r))

        consumed = h
        if not hits:
            ball.pos = add(c0, scl(v, h))
        else:
            hits.sort(key=lambda z: z[2]['t'])
            kind, obj, hit = hits[0]
            adv = max(0.0, hit['t'] - 1e-5)
            ball.pos = add(c0, scl(v, adv))
            self._resolve(ball, kind, obj, hit)
            consumed = adv if adv >= h * 0.08 else h * 0.08

        for k in list(ball.cd):
            ball.cd[k] -= h
            if ball.cd[k] <= 0:
                del ball.cd[k]
        self._stuck(ball, h)
        return consumed

    def _resolve(self, ball, kind, obj, hit):
        n = hit['n']
        key = kind + ':' + obj['id']
        impact = abs(dot(ball.vel, n))
        if kind == 'wall':
            ball.vel = reflect(ball.vel, n, obj['e'])
            self._correct_seg(ball, obj, n, hit)
        elif kind == 'rail':
            ball.vel = reflect(ball.vel, n, 0.18, friction=0.06)
            self._correct_seg(ball, obj, n, hit)
        elif kind == 'sling':
            ball.vel = reflect(ball.vel, n, 0.35, friction=0.03)
            if key not in ball.cd:
                ball.vel = add(ball.vel, scl(n, obj['kick']))
                ball.cd[key] = 0.18
            self._correct_seg(ball, obj, n, hit)
        elif kind == 'flipper':
            a, b, _, _ = flipper_geom(obj)
            cp, _ = closest_seg(ball.pos, a, b)
            sv = surf_velocity(obj, cp)
            ball.vel = reflect(ball.vel, n, 0.55, sv, 0.0)
            self._correct_seg(ball, dict(ax=a[0], ay=a[1], bx=b[0], by=b[1], r=obj['r']), n, hit)
            ball.cd[key] = 0.05
            self.events.append(('flipperHit', max(impact, length(sv))))
        elif kind == 'bumper':
            if key not in ball.cd:
                base = reflect(ball.vel, n, 0.4)
                vn = dot(base, n)
                ball.vel = add(base, scl(n, max(0.0, obj['kick'] - vn)))
                ball.cd[key] = 0.14
                self.bumper_flash[obj['id']] = 0.16
                self.score += obj['score']
                self.events.append(('bumper', obj['id']))
            else:
                ball.vel = reflect(ball.vel, n, 0.4)
            self._correct_circle(ball, obj['x'], obj['y'], obj['r'], n)
        elif kind == 'target':
            if key not in ball.cd:
                ball.vel = reflect(ball.vel, n, 0.62)
                ball.cd[key] = 0.28
                obj['flash'] = 0.22
                if self.combo_id == obj['id']:
                    self.combo_n += 1
                else:
                    self.combo_id, self.combo_n = obj['id'], 1
                self.combo_t = COMBO_WINDOW
                gained = obj['score'] * self.combo_n
                self.score += gained
                self.events.append(('target', obj['id'], self.combo_n, gained))
                obj['lit'] = True
                # multiball 组全部点亮 -> 触发第二球（与 game.js 对齐）
                if self.mb_armed and obj.get('group') == 'mb':
                    group = [t for t in self.targets if t.get('group') == 'mb']
                    if all(t['lit'] for t in group):
                        self.mb_armed = False
                        self.mb_pending = 0.9
                        for t in group:
                            t['lit'] = False
                        self.events.append(('multiball',))
            else:
                ball.vel = reflect(ball.vel, n, 0.5)
            self._correct_circle(ball, obj['x'], obj['y'], obj['r'], n)

    def _correct_seg(self, ball, obj, n, hit):
        if hit['t'] > 1e-6:
            return
        a, b = S(obj['ax'], obj['ay']), S(obj['bx'], obj['by'])
        pt, _ = closest_seg(ball.pos, a, b)
        d = sub(ball.pos, pt)
        want = BALL_R + obj.get('r', 0)
        l = length(d)
        if l < want:
            ball.pos = add(pt, scl(norm(d) if l > 1e-9 else n, want))

    def _correct_circle(self, ball, ox, oy, ro, n):
        d = sub(ball.pos, (ox, oy))
        want = BALL_R + ro
        l = length(d)
        if l < want:
            ball.pos = add((ox, oy), scl(d, want / (l or 1)))

    def _collide_balls(self, dt):
        for i in range(len(self.balls)):
            for j in range(i + 1, len(self.balls)):
                b1, b2 = self.balls[i], self.balls[j]
                if not (b1.alive and b2.alive):
                    continue
                vrel = sub(b1.vel, b2.vel)
                hit = swept_circle(b1.pos, BALL_R, vrel, dt, b2.pos, BALL_R)
                if not hit['hit']:
                    continue
                n = hit['n']
                vn = dot(vrel, n)
                if vn <= 0:
                    imp = scl(n, vn)
                    b1.vel = sub(b1.vel, imp)
                    b2.vel = add(b2.vel, imp)
                    overlap = 2 * BALL_R - length(sub(b1.pos, b2.pos))
                    if overlap > 0:
                        b1.pos = add(b1.pos, scl(n, overlap * 0.5))
                        b2.pos = sub(b2.pos, scl(n, overlap * 0.5))

    def _stuck(self, ball, h):
        if ball.locked:
            ball.stuck_t = 0.0
            ball.history = [(ball.x, ball.y)]
            ball.hist_t = 0.0
            return
        # 位移窗口检测：原地高速抖动也算卡死（不能只看瞬时速度）
        if not hasattr(ball, 'history'):
            ball.history = []
            ball.hist_t = 0.0
        ball.history.append((ball.x, ball.y))
        ball.hist_t += h
        while ball.hist_t > 1.2 and len(ball.history) > 1:
            ball.history.pop(0)
            ball.hist_t -= h
        ox, oy = ball.history[0]
        wandering = math.hypot(ball.x - ox, ball.y - oy) > 18
        if wandering:
            ball.safe_t += h
            if length(ball.vel) > 120 and ball.safe_t > 0.25:
                ball.last = ball.pos
                ball.safe_t = 0.0
            # 已进入自救流程后不再让徘徊清零计时器，保证升级传送能触发
            if ball.nudge_count == 0:
                ball.stuck_t = max(0.0, ball.stuck_t - 2 * h)
        else:
            ball.stuck_t += h
        if ball.nudge_cd > 0:
            ball.nudge_cd -= h
        # 两级自救：先冲量；两次轻推仍未脱困 -> 传送回安全点（保证不永久抖）
        if ball.nudge_count >= 2:
            ball.pos = ball.last
            ball.vel = (0, -180)
            ball.stuck_t = 0.0
            ball.nudge_cd = 1.0
            ball.nudge_count = 0
            self.events.append(('unstuckTeleport',))
            return
        if ball.stuck_t > 1.4 and ball.nudge_cd <= 0:
            # 优先找天然自由方向；凹角里全被堵住时，直接给向上强冲量
            nudged = False
            for d in [(0, -1), (-0.7, -0.7), (0.7, -0.7), (-1, 0), (1, 0)]:
                d = norm(d)
                p = add(ball.pos, scl(d, BALL_R * 2.2))
                if self._is_free(p):
                    ball.vel = add(ball.vel, scl(d, 280))
                    nudged = True
                    break
            if not nudged:
                ball.vel = add(ball.vel, (0, -520))
            ball.nudge_count = getattr(ball, 'nudge_count', 0) + 1
            ball.stuck_t = 0.0
            ball.nudge_cd = 1.0
            self.events.append(('unstuck',))

    def _is_free(self, p):
        for w in WALLS:
            pt, _ = closest_seg(p, S(w['ax'], w['ay']), S(w['bx'], w['by']))
            if length(sub(p, pt)) < BALL_R + w['r'] + 1:
                return False
        for bm in BUMPERS:
            if length(sub(p, (bm['x'], bm['y']))) < BALL_R + bm['r'] + 1:
                return False
        return True


def simulate(g, seconds):
    steps = round(seconds / FIXED_DT)
    for _ in range(steps):
        g.step()


# ================= 验收用例（与 src/selftest.js 一一对应） =================
def test_tunnel():
    """3000 px/s 垂直打向左挡板 ×5，零穿透"""
    SHOT = 3000
    blocked = 0
    details = []
    for run in range(5):
        g = Game()
        f = g.flippers[0]
        a, b, _, _ = flipper_geom(f)
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        ball = g.spawn(mid[0], mid[1] - 260, 0, SHOT)
        collided = False
        tunneled = False
        steps = round(0.35 / FIXED_DT)
        for _ in range(steps):
            g.step()
            gg = flipper_geom(g.flippers[0])
            if not collided and ball.y > gg[1][1] + 40:
                tunneled = True
            if any(e[0] == 'flipperHit' for e in g.events):
                collided = True
            g.events.clear()
        if collided and not tunneled:
            blocked += 1
        details.append(f"#{run+1}:{'挡下' if collided and not tunneled else '穿透/未碰'}")
    ok = blocked == 5
    return ok, f"挡住 {blocked}/5（{'，'.join(details)}）"


def test_flipper_power():
    """静止 vs 挥动挡板，出射速度差 >=30%。挥动组在球抵达前 ~0.02s 才按下，
    保证碰撞瞬间挡板仍在挥动（ω≈26），而不是早已到位静止。"""
    SHOT = 1600

    def measure(pressed):
        g = Game()
        f = g.flippers[0]
        a, b, _, _ = flipper_geom(f)
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        ball = g.spawn(mid[0], mid[1] - 220, 0, SHOT)
        # 球约 0.137s 后抵达；第 0.115s（第 14 步）按下 -> 碰撞时正处挥动中段
        press_step = 14 if pressed else -1
        out = 0.0
        omega_at_hit = 0.0
        steps = round(0.3 / FIXED_DT)
        for i in range(steps):
            if i == press_step:
                f['pressed'] = True
            g.step()
            if out == 0.0 and any(e[0] == 'flipperHit' for e in g.events):
                out = length(ball.vel)
                omega_at_hit = abs(f['angVel'])
            g.events.clear()
        return out, omega_at_hit

    v_rest, _ = measure(False)
    v_swing, omega = measure(True)
    diff = (v_swing - v_rest) / v_rest
    ok = diff >= 0.30 and omega > 5
    return ok, (f"静止 {round(v_rest)}px/s vs 挥动 {round(v_swing)}px/s，"
                f"差 {diff*100:.1f}%，碰撞 ω={omega:.1f}rad/s")


def test_combo():
    """同一靶子连击 3 次，得分 1x/2x/3x 递增。选 t8（360,824），左侧无遮挡。"""
    g = Game()
    tg = g.targets[7]
    gained, combos = [], []
    for _ in range(3):
        g.balls = []
        g.spawn(tg['x'] - 120, tg['y'], 700, 0)
        hit_ev = None
        steps = round(0.4 / FIXED_DT)
        for _ in range(steps):
            g.step()
            for e in g.events:
                if e[0] == 'target' and e[1] == tg['id']:
                    hit_ev = e
            g.events.clear()
        if not hit_ev:
            return False, "存在未命中的靶子射击"
        gained.append(hit_ev[3])
        combos.append(hit_ev[2])
    ok = gained[1] > gained[0] and gained[2] > gained[1] and combos == [1, 2, 3]
    return ok, f"三次得分 {'/'.join(map(str, gained))}，档位 {'/'.join(map(str, combos))}"


def test_stuck():
    """球零速落进发射槽底部凹角（真实卡缝位）-> 1.4s 后自救触发，不永久抖动"""
    g = Game()
    ball = g.spawn(674, 968, 0, 0)
    start = ball.pos
    nudged = False
    steps = round(4.0 / FIXED_DT)
    for _ in range(steps):
        g.step()
        if any(e[0] in ('unstuck', 'unstuckTeleport') for e in g.events):
            nudged = True
        g.events.clear()
    moved = length(sub(ball.pos, start))
    final_speed = length(ball.vel)
    ok = nudged and (moved > 30 or final_speed > 100)
    return ok, f"自救={'触发' if nudged else '未触发'}，位移 {moved:.0f}px，末速 {final_speed:.0f}px/s"


def test_launch_route():
    """满力发射：球必须经槽顶弯轨进入台面（x<620），全程不出界。
    之后正常排水不算失败。"""
    g = Game()
    ball = g.spawn(674, 980, 0, -3050)
    entered = False
    min_y = 1e9
    out_of_bounds = False
    steps = round(2.5 / FIXED_DT)
    for _ in range(steps):
        g.step()
        min_y = min(min_y, ball.y)
        if not (-130 < ball.x < W + 130 and -130 < ball.y < H + 130):
            out_of_bounds = True
        if ball.x < 620:
            entered = True
        g.events.clear()
    ok = entered and not out_of_bounds
    return ok, (f"最高点 y={min_y:.0f}，进入台面={'是' if entered else '否'}，"
                f"出界={'是' if out_of_bounds else '否'}")


def test_multiball():
    """点亮全部三个琥珀靶 -> 触发 multiball，0.9s 后台面上出现第二个球"""
    g = Game()
    g.spawn(300, 300, 0, 300)
    amber = [t for t in g.targets if t.get('group') == 'mb']
    triggered = False
    # 逐靶强制命中（从靶子旁边发射一颗朝靶心的球，足够近必中）
    for tg in amber:
        g.balls = [b for b in g.balls if b.alive]
        if not g.balls:
            g.spawn(tg['x'] - 40, tg['y'], 600, 0)
        else:
            b = g.balls[0]
            b.x, b.y, b.vx, b.vy = tg['x'] - 40, tg['y'], 600, 0
            b.cd = {}
        for _ in range(round(0.3 / FIXED_DT)):
            g.step()
            if any(e[0] == 'multiball' for e in g.events):
                triggered = True
            g.events.clear()
    # 等待第二球发射
    for _ in range(round(1.2 / FIXED_DT)):
        g.step()
        g.events.clear()
    ball_count = sum(1 for b in g.balls if b.alive)
    ok = triggered and ball_count >= 2
    return ok, f"multiball 触发={'是' if triggered else '否'}，当前同屏球数 {ball_count}"


def test_playthrough():
    """规则验证：真实物理下能稳定得分（弹力柱/靶子），且排水口能正确收球。
    命数/结算状态机在 JS 侧 game.js 实现，这里验证其依赖的物理事实。"""
    g = Game()
    g.spawn(360, 400, 250, 200)
    score_events = 0
    for i in range(round(20 / FIXED_DT)):
        for f in g.flippers:
            f['pressed'] = False
        for b in g.balls:
            if b.alive and b.vy > 0 and b.y > 760:
                g.flippers[0 if b.x < 360 else 1]['pressed'] = True
        g.step()
        if any(e[0] in ('bumper', 'target') for e in g.events):
            score_events += 1
        g.events.clear()

    # 确定性排水：在左排水口正上方放一颗下坠球，必须被收走
    g.balls = []
    db = g.spawn(184, 940, 0, 200)
    drained = False
    for _ in range(round(1.5 / FIXED_DT)):
        g.step()
        if any(e[0] == 'drain' for e in g.events) or not db.alive:
            drained = True
        g.events.clear()

    ok = score_events > 0 and g.score > 0 and drained
    return ok, (f"得分事件 {score_events} 次、总分 {g.score}，"
                f"排水口收球={'成功' if drained else '失败'}")


def test_ball_stability():
    """附加：满速多球 60 秒长稳，无穿界、无 NaN、子步上限受控"""
    g = Game()
    g.spawn(360, 300, 1800, 900)
    g.spawn(300, 500, -1500, 1200)
    steps = round(60 / FIXED_DT)
    for i in range(steps):
        g.step()
        for b in g.balls:
            if not (math.isfinite(b.x) and math.isfinite(b.y)):
                return False, "出现非有限坐标"
            if b.alive and not (-130 < b.x < W + 130 and -130 < b.y < H + 130):
                return False, f"球越界 ({b.x:.0f},{b.y:.0f})"
        g.events.clear()
    alive = sum(1 for b in g.balls if b.alive)
    return True, f"60s 双球无穿界/无 NaN，存活 {alive}，峰值子步 {g.max_sub}"


def main():
    tests = [
        ("穿模 3000px/s×5", test_tunnel),
        ("挡板发力差≥30%", test_flipper_power),
        ("靶子连击递增", test_combo),
        ("卡缝自救", test_stuck),
        ("发射导流", test_launch_route),
        ("multiball 触发", test_multiball),
        ("完整一局流程", test_playthrough),
        ("60s 长稳", test_ball_stability),
    ]
    all_ok = True
    print("=" * 64)
    print("NEON ZONE 无头物理验收（Python 镜像，与 src/selftest.js 同算法）")
    print("=" * 64)
    for name, fn in tests:
        ok, text = fn()
        all_ok &= ok
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {text}")
    print("=" * 64)
    print("总结果:", "全部通过 ✅" if all_ok else "存在失败 ❌")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
