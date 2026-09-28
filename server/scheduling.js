import db, { getSetting, setSetting, tx } from './db.js'

// 员工排班与工时结算模块：
// 班次定义 → 主管排班（冲突/离岗/岗位覆盖校验）→ 员工签到（迟到/旷工）→ 在岗考勤
// （检修/投诉岗位覆盖由 isStaffOnDuty 回调，完工回写作业工时与满意度）→ 到点/加班签退
// → 工时/加班/夜班费结算逐条入工资财务；跨日夜班日结结转、次日下班按排班归属日跨日结算；
// 调班申请员工发起、主管审批，审批通过原子移交班次；离岗释放未开始班次并结算在岗考勤。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const OPEN_HOUR = 9
const CLOSE_HOUR = 18
const TICKS_PER_DAY = 10  // 营业时段 9:00~18:00 共 10 个游戏小时（引擎每 tick 先加 1）
const STANDARD_HOURS = 9  // 标准工作时长 9:00~18:00 共 9 小时；时薪=日薪/9，全天班正好拿满日薪
const SCHED_ERR = {
  NOT_FOUND: 'SCHED_NOT_FOUND',
  STAFF_NOT_FOUND: 'SCHED_STAFF_NOT_FOUND',
  STAFF_LEAVE: 'SCHED_STAFF_ON_LEAVE',
  SHIFT_NOT_FOUND: 'SHIFT_NOT_FOUND',
  CONFLICT: 'SCHED_CONFLICT',
  STATUS_CONFLICT: 'SCHED_STATUS_CONFLICT',
  NO_SHIFT: 'SCHED_NO_SHIFT_TODAY',
  ALREADY_CHECKED: 'SCHED_ALREADY_CHECKED',
  NOT_CHECKED: 'SCHED_NOT_CHECKED_IN',
  PAST_DAY: 'SCHED_PAST_DAY',
  ROLE_MISMATCH: 'SCHED_ROLE_MISMATCH',
  PENDING_EXISTS: 'SCHED_SWAP_PENDING',
  TX_FAILED: 'TX_FAILED'
}
const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })
class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}
function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    console.error('[scheduling] 事务执行失败，已整体回滚:', e)
    return fail(SCHED_ERR.TX_FAILED, '排班系统繁忙，本次操作未生效，请稍后重试')
  }
}

// 由 index.js 注入：时钟 / 现金 / 财务流水
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null
}
export function initSchedulingContext(deps) { Object.assign(ctx, deps) }

// 幂等执行：签到/签退/排班/调班等写操作按 scope+requestId 缓存首次结果，双击/重放不重复结算
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== SCHED_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

// ---------------- 时间几何 ----------------
// day d 的 9:00 对应 tick=(d-1)*10；跨日夜班 17→次日9 的 tick 跨度自动压缩闭园空窗
const dayStartTick = d => (d - 1) * TICKS_PER_DAY
const shiftWindow = (day, sh) => {
  const start = dayStartTick(day) + (sh.start_hour - OPEN_HOUR)
  const end = sh.end_hour < sh.start_hour
    ? dayStartTick(day + 1) + (sh.end_hour - OPEN_HOUR)   // 跨日：结束落在次日
    : dayStartTick(day) + (sh.end_hour - OPEN_HOUR)
  return { start, end, cross: sh.end_hour < sh.start_hour }
}
// 计划工时（分钟）：跨日 = 开园内段(18→start) + 闭园夜段 6h + 次日凌晨段
const plannedMinutesOf = sh => sh.end_hour < sh.start_hour
  ? ((CLOSE_HOUR - sh.start_hour) + 6 + sh.end_hour) * 60
  : (sh.end_hour - sh.start_hour) * 60

const cfg = (k, d) => num(getSetting(k), d)
const getShift = id => db.prepare('SELECT * FROM shift_types WHERE id=?').get(id)
const getStaff = id => db.prepare('SELECT * FROM staff WHERE id=?').get(id)
const activeScheduleStates = ["status IN ('scheduled','checked')"]

function logS(scheduleId, action, note = '', staffId = null, operatorId = null) {
  db.prepare('INSERT INTO schedule_logs(schedule_id,staff_id,tick,day,hour,action,note,operator_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(scheduleId, staffId, ctx.tick(), ctx.day(), ctx.hour(), action, note, operatorId)
}

// ---------------- 班次配置（运营主管） ----------------
export function listShiftTypes() {
  return db.prepare('SELECT * FROM shift_types ORDER BY sort,id').all()
}

export function updateShiftType(id, b = {}) {
  const sh = getShift(id)
  if (!sh) return fail(SCHED_ERR.SHIFT_NOT_FOUND, '班次不存在')
  const start = b.start_hour !== undefined ? Math.round(num(b.start_hour)) : sh.start_hour
  const end = b.end_hour !== undefined ? Math.round(num(b.end_hour)) : sh.end_hour
  if (!Number.isInteger(start) || start < 0 || start > 23) return fail(SCHED_ERR.BAD_ARG, '上班时刻需为 0~23 的整数')
  if (!Number.isInteger(end) || end < 0 || end > 23) return fail(SCHED_ERR.BAD_ARG, '下班时刻需为 0~23 的整数')
  if (end === start) return fail(SCHED_ERR.BAD_ARG, '上下班时刻不能相同')
  const cross = end < start
  let nightHours = Math.round(num(b.night_hours, sh.night_hours) * 10) / 10
  if (nightHours < 0 || nightHours > 12) return fail(SCHED_ERR.BAD_ARG, '夜班工时需在 0~12 之间')
  if (!cross) nightHours = 0
  db.prepare('UPDATE shift_types SET name=?,start_hour=?,end_hour=?,night_hours=?,active=? WHERE id=?')
    .run(String(b.name || sh.name).slice(0, 12), start, end, nightHours, b.active === false ? 0 : 1, id)
  return { ok: true }
}

// ---------------- 冲突 / 覆盖校验 ----------------
// 同一员工时间窗重叠（端点相接允许不同人交接，但同一人首尾相接=无休息也判冲突）；
// 同时检查前一日跨日结转班与次日班
function findConflict(staffId, day, sh, excludeScheduleId = 0) {
  const win = shiftWindow(day, sh)
  const rows = db.prepare(`SELECT sc.*, sh.start_hour, sh.end_hour FROM schedules sc
                           JOIN shift_types sh ON sh.id=sc.shift_id
                           WHERE sc.staff_id=? AND sc.day IN (?,?,?) AND sc.status IN ('scheduled','checked') AND sc.id<>?`)
    .all(staffId, day - 1, day, day + 1, excludeScheduleId)
  for (const r of rows) {
    const w = shiftWindow(r.day, r)
    if (win.start < w.end && win.end > w.start) return r
    // 同一员工跨日首尾相接（如夜班 9 点下班接 9 点早班）：无休息时间，拒绝
    if (win.start === w.end || win.end === w.start) return r
  }
  return null
}

// 岗位覆盖：在途检修工单需维修、待处置投诉需对应岗位，另保保安/保洁基本在岗
// 返回 {rows, missing}：缺岗为排班警告（软校验，主管仍可排，系统给提示）
export function coverageForDay(day) {
  const scheds = db.prepare(`SELECT sc.*, st.role role FROM schedules sc
                             JOIN staff st ON st.id=sc.staff_id
                             WHERE sc.day=? AND sc.status IN ('scheduled','checked')`).all(day)
  // 前一日跨日夜班结转至当日上午的，计入当日覆盖
  const carried = db.prepare(`SELECT st.role role FROM schedules sc
                              JOIN shift_types sh ON sh.id=sc.shift_id
                              JOIN staff st ON st.id=sc.staff_id
                              WHERE sc.day=? AND sc.status='checked' AND sh.end_hour<sh.start_hour`).all(day - 1)
  const onDutyRoles = {}
  for (const s of [...scheds, ...carried]) onDutyRoles[s.role] = (onDutyRoles[s.role] || 0) + 1

  const openOrders = db.prepare("SELECT COUNT(*) n FROM maintenance_orders WHERE status IN ('queued','processing')").get().n
  const need = { '保安': 1, '安保': 0, '保洁': 1, '维修': openOrders > 0 ? 1 : 0, '会员专员': 0 }
  // 投诉按受理岗位汇总需求（无专属岗位的 service/pricing 不强制）
  const ROLE_OF_CAT = { queue: ['保安', '安保'], hygiene: ['保洁'], facility: ['维修'], safety: ['保安', '安保'], food: ['保洁'], missing: ['保安', '安保'] }
  const comps = db.prepare("SELECT category, COUNT(*) n FROM complaints WHERE status IN ('open','processing','ready') GROUP BY category").all()
  for (const c of comps) for (const role of (ROLE_OF_CAT[c.category] || [])) need[role] = (need[role] || 0) + c.n

  const rows = Object.entries(need).map(([role, n]) => ({ role, need: n, have: onDutyRoles[role] || 0 }))
  const missing = rows.filter(r => r.have < r.need).map(r => ({ ...r, short: r.need - r.have }))
  return { rows, missing, openOrders, openComplaints: comps.reduce((s, c) => s + c.n, 0) }
}

// ---------------- 排班 / 改派 / 取消 ----------------
function createScheduleRow(staffId, day, shiftId, source, note) {
  const r = db.prepare(`INSERT INTO schedules(code,staff_id,day,shift_id,status,source,create_tick,create_day,note)
                        VALUES(?,?,?,?,'scheduled',?,?,?,?)`)
    .run('', staffId, day, shiftId, source, ctx.tick(), ctx.day(), note || '')
  const id = Number(r.lastInsertRowid)
  db.prepare('UPDATE schedules SET code=? WHERE id=?').run('PB' + String(id).padStart(4, '0'), id)
  return id
}

export function createSchedule({ staffId, day, shiftId, source = 'manual', note = '', requestId = '' }) {
  return idempotent('sched_create', requestId, () => runAtomic(() => {
    staffId = Math.round(num(staffId))
    shiftId = Math.round(num(shiftId))
    day = Math.round(num(day))
    const st = getStaff(staffId)
    if (!st) throw new TxError(SCHED_ERR.STAFF_NOT_FOUND, '员工不存在')
    if (!st.active) throw new TxError(SCHED_ERR.STAFF_LEAVE, `${st.name} 已离岗，不可排班（可先在员工管理返聘）`)
    const sh = getShift(shiftId)
    if (!sh || !sh.active) throw new TxError(SCHED_ERR.SHIFT_NOT_FOUND, '班次不存在或已停用')
    if (!day || day < ctx.day()) throw new TxError(SCHED_ERR.PAST_DAY, '不可为过去的日期补排班次（当日仍可排班）')
    const conflict = findConflict(staffId, day, sh)
    if (conflict) {
      const cs = getShift(conflict.shift_id)
      throw new TxError(SCHED_ERR.CONFLICT, `${st.name} ${conflict.day === day ? '当日' : `第 ${conflict.day} 天`}已有「${cs.name}」时间重叠，请选择其他班次或先调班`)
    }
    const id = createScheduleRow(staffId, day, shiftId, source === 'auto' ? 'auto' : 'manual', note)
    logS(id, source === 'auto' ? 'auto' : 'create',
      `${source === 'auto' ? '系统自动铺班' : '运营主管排班'}：${st.name}（${st.role}）第 ${day} 天「${sh.name}」${sh.start_hour}:00-${sh.end_hour}:00${sh.end_hour < sh.start_hour ? '（跨日）' : ''}`,
      staffId)
    return { ok: true, id, code: 'PB' + String(id).padStart(4, '0'), coverage: coverageForDay(day) }
  }))
}

// 主管改派（仅未签到班次）
export function reassignSchedule(id, newStaffId, operatorId = null) {
  return runAtomic(() => {
    const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(id)
    if (!sc) throw new TxError(SCHED_ERR.NOT_FOUND, '排班不存在')
    if (sc.status !== 'scheduled') throw new TxError(SCHED_ERR.STATUS_CONFLICT, '已签到或已结算的班次不能改派，请走调班或先签退结算')
    const st = getStaff(newStaffId)
    if (!st) throw new TxError(SCHED_ERR.STAFF_NOT_FOUND, '员工不存在')
    if (!st.active) throw new TxError(SCHED_ERR.STAFF_LEAVE, `${st.name} 已离岗，不可改派`)
    const sh = getShift(sc.shift_id)
    const conflict = findConflict(st.id, sc.day, sh, sc.id)
    if (conflict) throw new TxError(SCHED_ERR.CONFLICT, `${st.name} 该时段已有重叠班次`)
    const old = getStaff(sc.staff_id)
    db.prepare('UPDATE schedules SET staff_id=? WHERE id=?').run(st.id, id)
    logS(id, 'reassign', `主管改派：${old?.name || '员工'} 的「${sh.name}」改由 ${st.name}（${st.role}）承接`, st.id, operatorId)
    return { ok: true }
  })
}

export function cancelSchedule(id, operatorId = null) {
  return runAtomic(() => {
    const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(id)
    if (!sc) throw new TxError(SCHED_ERR.NOT_FOUND, '排班不存在')
    if (sc.status === 'done' || sc.status === 'cancelled' || sc.status === 'missed') {
      throw new TxError(SCHED_ERR.STATUS_CONFLICT, '该班次已结算/取消，不可重复操作')
    }
    if (sc.status === 'checked') throw new TxError(SCHED_ERR.STATUS_CONFLICT, '员工已签到，请先签退结算再取消')
    const pend = db.prepare("SELECT id FROM shift_swaps WHERE schedule_id=? AND status='pending'").all(id)
    if (pend.length) throw new TxError(SCHED_ERR.PENDING_EXISTS, '该班次有待审批调班申请，请先处理')
    const sh = getShift(sc.shift_id)
    db.prepare("UPDATE schedules SET status='cancelled' WHERE id=?").run(id)
    logS(id, 'cancel', `运营取消第 ${sc.day} 天「${sh.name}」排班`, sc.staff_id, operatorId)
    return { ok: true }
  })
}

// 自动铺班：当日尚无任何排班时，按在岗员工岗位铺默认班次（主管之后可调整/调班）
export function ensureAutoSchedule() {
  let made = 0
  for (const day of [ctx.day(), ctx.day() + 1]) {
    const n = db.prepare('SELECT COUNT(*) n FROM schedules WHERE day=?').get(day).n
    if (n > 0 || day < ctx.day()) continue
    made += autoScheduleDay(day)
  }
  return made
}

export function autoScheduleDay(day) {
  const staff = db.prepare('SELECT * FROM staff WHERE active=1 ORDER BY id').all()
  const shifts = listShiftTypes().filter(s => s.active)
  const byCode = Object.fromEntries(shifts.map(s => [s.code, s]))
  const guards = staff.filter(s => s.role === '保安' || s.role === '安保')
  let made = 0
  for (const st of staff) {
    // 已有任意未取消班次（含跨日相邻）则跳过
    const exist = db.prepare("SELECT COUNT(*) n FROM schedules WHERE staff_id=? AND day=? AND status IN ('scheduled','checked')").get(st.id, day).n
    if (exist) continue
    let code = 'mid'
    if (st.role === '保洁') code = 'early'
    else if (st.role === '维修') code = 'full'
    else if (st.role === '会员专员') code = 'mid'
    else if (guards.length >= 2 && st.id === guards[guards.length - 1].id) code = 'night' // 留 1 名保安值跨日夜班
    else if (st.role === '保安' || st.role === '安保') code = 'full'
    const sh = byCode[code] || shifts[0]
    if (!sh) continue
    // 冲突（极端情况相邻日跨日班）则跳过
    if (findConflict(st.id, day, sh)) continue
    const id = createScheduleRow(st.id, day, sh.id, 'auto', '系统自动铺班，主管可调整')
    logS(id, 'auto', `自动铺班：${st.name}（${st.role}）第 ${day} 天「${sh.name}」`, st.id)
    made++
  }
  return made
}

// ---------------- 签到 / 签退 ----------------
function findCheckinable(staffId) {
  const tick = ctx.tick()
  const rows = db.prepare(`SELECT sc.id sid, sc.staff_id, sc.day sday, sc.status, sc.attendance_id,
                                  sh.id shift_id, sh.name shift_name, sh.start_hour, sh.end_hour, sh.night_hours, sh.active
                           FROM schedules sc
                           JOIN shift_types sh ON sh.id=sc.shift_id
                           WHERE sc.staff_id=? AND sc.status='scheduled'
                           AND sc.day IN (?,?,?)`).all(staffId, ctx.day() - 1, ctx.day(), ctx.day() + 1)
  for (const r of rows) {
    const sh = { id: r.shift_id, name: r.shift_name, start_hour: r.start_hour, end_hour: r.end_hour, night_hours: r.night_hours, active: r.active }
    const sc = { id: r.sid, staff_id: r.staff_id, day: r.sday, status: r.status, attendance_id: r.attendance_id, shift_id: r.shift_id }
    const w = shiftWindow(sc.day, sh)
    // 已过下班点不可补签；跨日班在次日窗口内仍可签
    if (tick >= w.start && tick < w.end) return { sc, sh, win: w }
  }
  return null
}

export function checkIn({ staffId, requestId = '' }) {
  return idempotent('sched_checkin', requestId, () => runAtomic(() => {
    const st = getStaff(staffId)
    if (!st) throw new TxError(SCHED_ERR.STAFF_NOT_FOUND, '员工不存在')
    if (!st.active) throw new TxError(SCHED_ERR.STAFF_LEAVE, '员工已离岗，不能签到')
    const open = db.prepare("SELECT id FROM attendances WHERE staff_id=? AND status='checked_in'").get(st.id)
    if (open) throw new TxError(SCHED_ERR.ALREADY_CHECKED, '已在考勤中，请先签退')
    const found = findCheckinable(st.id)
    if (!found) throw new TxError(SCHED_ERR.NO_SHIFT, '当前没有待签到的班次（未排班或已过上班/下班时间）')
    const { sc, sh, win } = found
    const graceMin = cfg('lateGrace', 15)
    // 迟到游戏小时折算分钟（1 tick=60 分钟）后扣减宽限
    const lateMinutes = Math.max(0, (ctx.tick() - win.start) * 60 - graceMin)
    const r = db.prepare(`INSERT INTO attendances(schedule_id,staff_id,day,status,checkin_tick,checkin_day,checkin_hour,late_minutes)
                          VALUES(?,?,?, 'checked_in',?,?,?,?)`)
      .run(sc.id, st.id, sc.day, ctx.tick(), ctx.day(), ctx.hour(), Math.round(lateMinutes))
    const aid = Number(r.lastInsertRowid)
    db.prepare("UPDATE schedules SET status='checked', attendance_id=? WHERE id=?").run(aid, sc.id)
    logS(sc.id, lateMinutes > 0 ? 'late' : 'checkin',
      `${st.name} 签到「${sh.name}」${lateMinutes > 0 ? `，迟到 ${lateMinutes} 分钟` : '，准时到岗'}`, st.id)
    return { ok: true, attendanceId: aid, lateMinutes: Math.round(lateMinutes), shift: sh.name }
  }))
}

// 结算一笔考勤（与现金/工资流水/工资单同一事务）
function settleAttendance(sc, att, sh, checkoutTick, checkoutDay, checkoutHour) {
  const st = getStaff(sc.staff_id)
  const wage = st?.wage || 0
  const hourly = wage / STANDARD_HOURS
  const workedTicks = Math.max(0, checkoutTick - att.checkin_tick)
  const workedMinutes = workedTicks * 60
  const planned = plannedMinutesOf(sh)
  const cross = sh.end_hour < sh.start_hour
  const nightMinutes = cross ? Math.round(sh.night_hours * 60) : 0
  const overtimeMinutes = Math.max(0, workedMinutes - planned)
  // 跨日夜班按计划工时保底（闭园夜段无模拟时钟）；普通班按实际在岗与计划取小
  const baseMinutes = cross ? planned : Math.min(workedMinutes, planned)
  const basePay = Math.round(baseMinutes / 60 * hourly)
  const overtimePay = Math.round(overtimeMinutes / 60 * hourly * cfg('overtimeRate', 1.5))
  const nightPay = Math.round(nightMinutes / 60 * cfg('nightAllowance', 12))
  const rawDeduct = att.late_minutes / 60 * hourly
  const deduction = Math.min(Math.round(rawDeduct), Math.round(wage * cfg('lateDeductCap', 0.2)))
  const amount = Math.max(0, basePay + overtimePay + nightPay - deduction)

  const pr = db.prepare(`INSERT INTO payroll_entries(code,staff_id,schedule_id,attendance_id,day,kind,
      base_pay,overtime_pay,night_pay,deduction,amount,worked_minutes,overtime_minutes,tick,note)
      VALUES(?,?,?,?,?,'shift',?,?,?,?,?,?,?,?,?)`)
    .run('', st.id, sc.id, att.id, sc.day, basePay, overtimePay, nightPay, deduction, amount,
      workedMinutes, overtimeMinutes, ctx.tick(),
      `${sh.name}${cross ? '（跨日夜班）' : ''}${overtimeMinutes > 0 ? `·加班 ${Math.round(overtimeMinutes / 60 * 10) / 10}h` : ''}${att.late_minutes > 0 ? `·迟到扣减` : ''}`)
  const pid = Number(pr.lastInsertRowid)
  db.prepare('UPDATE payroll_entries SET code=? WHERE id=?').run('GZ' + String(pid).padStart(4, '0'), pid)

  db.prepare(`UPDATE attendances SET status='checked_out', checkout_tick=?, checkout_day=?, checkout_hour=?,
      worked_minutes=?, night_minutes=?, overtime_minutes=? WHERE id=?`)
    .run(checkoutTick, checkoutDay, checkoutHour, workedMinutes, nightMinutes, overtimeMinutes, att.id)
  db.prepare("UPDATE schedules SET status='done', payroll_id=? WHERE id=?").run(pid, sc.id)

  setSetting('cash', Math.round(ctx.cash() - amount))
  ctx.logFinance?.(ctx.day(), '工资', -amount,
    `排班结算 ${st?.name}「${sh.name}」第${sc.day}天${cross ? '（跨日结算）' : ''}：基本 ¥${basePay}${overtimePay ? `·加班 ¥${overtimePay}` : ''}${nightPay ? `·夜班 ¥${nightPay}` : ''}${deduction ? `·迟到扣 ¥${deduction}` : ''}`)

  // 完工回写满意度：完成班次 +2，加班额外 +1，迟到 -2
  let morale = st.morale + 2 + (overtimeMinutes > 0 ? 1 : 0) - (att.late_minutes > 0 ? 2 : 0)
  morale = Math.max(20, Math.min(100, morale))
  db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.round(morale), st.id)
  db.prepare('UPDATE payroll_entries SET satisfaction=? WHERE id=?').run(Math.round(morale - st.morale), pid)

  logS(sc.id, 'checkout',
    `${st.name} 签退：在岗 ${(workedMinutes / 60).toFixed(1)}h${overtimeMinutes ? `，加班 ${(overtimeMinutes / 60).toFixed(1)}h` : ''}，应发 ¥${amount}`,
    st.id)
  return { pid, amount, basePay, overtimePay, nightPay, deduction, workedMinutes, overtimeMinutes }
}

export function checkOut({ staffId, requestId = '' }) {
  return idempotent('sched_checkout', requestId, () => runAtomic(() => {
    const st = getStaff(staffId)
    if (!st) throw new TxError(SCHED_ERR.STAFF_NOT_FOUND, '员工不存在')
    const att = db.prepare("SELECT * FROM attendances WHERE staff_id=? AND status='checked_in'").get(st.id)
    if (!att) throw new TxError(SCHED_ERR.NOT_CHECKED, '当前没有考勤中的班次')
    const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(att.schedule_id)
    const sh = getShift(sc.shift_id)
    const w = shiftWindow(sc.day, sh)
    if (ctx.tick() < w.start + 1) throw new TxError(SCHED_ERR.STATUS_CONFLICT, '上岗不足 1 小时，不能签退')
    const r = settleAttendance(sc, att, sh, ctx.tick(), ctx.day(), ctx.hour())
    return { ok: true, ...r }
  }))
}

// 每游戏小时推进：自动打卡（模拟员工签到，偶发迟到/漏签）+ 到点自动签退
// 跨日已结转班在次日到达下班 tick 时自动签退并按排班归属日跨日结算
export function processSchedules() {
  const tick = ctx.tick()
  // 仅取 id（JOIN 班次表避免同名列覆盖），行内再按 id 取最新整行
  const ids = db.prepare(`SELECT sc.id FROM schedules sc
                          JOIN shift_types sh ON sh.id=sc.shift_id
                          WHERE sc.status IN ('scheduled','checked')`).all().map(r => r.id)
  for (const sid of ids) {
    try {
      const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(sid)
      if (!sc || !['scheduled', 'checked'].includes(sc.status)) continue
      const sh = getShift(sc.shift_id)
      const w = shiftWindow(sc.day, sh)
      if (sc.status === 'scheduled') {
        // 模拟员工到岗：上班 tick 65% 准时自动打卡；之后每 tick 70% 补打卡（迟到）；下班仍未签则日结局按旷工
        if (tick === w.start && Math.random() < 0.65) {
          autoCheckIn(sc, sh, 0)
        } else if (tick > w.start && tick < w.end - 1 && Math.random() < 0.7) {
          const lateMin = (tick - w.start) * 60 - cfg('lateGrace', 15)
          autoCheckIn(sc, sh, Math.max(0, lateMin))
        }
        continue
      }
      // checked：到点自动签退（正点结算不产生加班；加班需员工主动延时签退）
      const att = db.prepare("SELECT * FROM attendances WHERE id=? AND status='checked_in'").get(sc.attendance_id)
      if (att && tick >= w.end) {
        runAtomic(() => settleAtTick(sc, att, sh, w.end))
      }
    } catch (e) {
      console.error(`[scheduling] 排班 #${sid} 推进失败（跳过，不影响其他排班）:`, e)
    }
  }
}
// 在指定 tick 签退并换算结算日/时刻（跨日次日下班时 day 自动 +1）
function settleAtTick(sc, att, sh, tick) {
  const totalDays = Math.floor(tick / TICKS_PER_DAY) + 1
  const hour = OPEN_HOUR + (tick % TICKS_PER_DAY)
  return settleAttendance(sc, att, sh, tick, totalDays, hour)
}
function autoCheckIn(sc, sh, lateMinutes) {
  const r = db.prepare(`INSERT INTO attendances(schedule_id,staff_id,day,status,checkin_tick,checkin_day,checkin_hour,late_minutes)
                        VALUES(?,?,?, 'checked_in',?,?,?,?)`)
    .run(sc.id, sc.staff_id, sc.day, ctx.tick(), ctx.day(), ctx.hour(), Math.round(lateMinutes))
  const aid = Number(r.lastInsertRowid)
  db.prepare("UPDATE schedules SET status='checked', attendance_id=? WHERE id=?").run(aid, sc.id)
  logS(sc.id, lateMinutes > 0 ? 'late' : 'checkin',
    `系统打卡：${getStaff(sc.staff_id)?.name}「${sh.name}」${lateMinutes > 0 ? `迟到 ${Math.round(lateMinutes)} 分钟` : '准时到岗'}`, sc.staff_id)
}

// 日结（闭园跨天前调用）：旷工判定、跨日夜班结转、待工补贴；返回日工资合计供主循环对账
export function settleDayEnd(day) {
  return runAtomic(() => {
    let payable = 0
    // 1) 当日未签到 → 旷工（无底薪，满意度 -8）
    const missing = db.prepare("SELECT * FROM schedules WHERE day=? AND status='scheduled'").all(day)
    for (const sc of missing) {
      const sh = getShift(sc.shift_id)
      const r = db.prepare(`INSERT INTO attendances(schedule_id,staff_id,day,status,night_minutes) VALUES(?,?,?, 'missing',0)`)
        .run(sc.id, sc.staff_id, day)
      const aid = Number(r.lastInsertRowid)
      const pr = db.prepare(`INSERT INTO payroll_entries(code,staff_id,schedule_id,attendance_id,day,kind,amount,tick,note)
                             VALUES(?,?,?,?,?, 'absence',0,?, '旷工，无工资')`)
        .run('', sc.staff_id, sc.id, aid, day, ctx.tick())
      const pid = Number(pr.lastInsertRowid)
      db.prepare('UPDATE payroll_entries SET code=? WHERE id=?').run('GZ' + String(pid).padStart(4, '0'), pid)
      db.prepare("UPDATE schedules SET status='missed', attendance_id=?, payroll_id=? WHERE id=?").run(aid, pid, sc.id)
      const st = getStaff(sc.staff_id)
      if (st) db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.max(20, st.morale - 8), st.id)
      logS(sc.id, 'missing', `${st?.name || '员工'}「${sh.name}」缺勤旷工，当日无工资`, sc.staff_id)
    }
    // 2) 仍在考勤中的：跨日夜班结转（夜段津贴次日结算时统一发）；其余兜底正点签退
    const checkedIds = db.prepare("SELECT sc.id FROM schedules sc JOIN shift_types sh ON sh.id=sc.shift_id WHERE sc.day=? AND sc.status='checked'").all(day).map(r => r.id)
    for (const sid of checkedIds) {
      const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(sid)
      const sh = getShift(sc.shift_id)
      const att = db.prepare("SELECT * FROM attendances WHERE id=? AND status='checked_in'").get(sc.attendance_id)
      if (!att) continue
      if (sh.end_hour < sh.start_hour) {
        db.prepare('UPDATE attendances SET carried=1, night_minutes=? WHERE id=?').run(Math.round(sh.night_hours * 60), att.id)
        logS(sc.id, 'carry', `${getStaff(sc.staff_id)?.name}「${sh.name}」跨日夜班结转至次日，闭园夜段 ${sh.night_hours}h 计入夜班工时`, sc.staff_id)
      } else {
        const w = shiftWindow(day, sh)
        const r = settleAtTick(sc, att, sh, w.end)
        payable += r.amount
      }
    }
    // 3) 待工补贴：当日在岗但全天无任何排班记录（含旷工/已结算/出勤）的员工，按日薪比例发待工工资；
    //    旷工（missed）或已结算（done/checked）当天均不再发待工，避免「缺勤还领补贴」
    const staff = db.prepare('SELECT * FROM staff WHERE active=1').all()
    for (const st of staff) {
      const has = db.prepare("SELECT COUNT(*) n FROM schedules WHERE staff_id=? AND day=? AND status IN ('scheduled','checked','done','missed')").get(st.id, day).n
      // 从前一日结转的跨日班已覆盖当日，不再发待工
      const carriedIn = db.prepare(`SELECT COUNT(*) n FROM schedules sc JOIN shift_types sh ON sh.id=sc.shift_id
                                    WHERE sc.staff_id=? AND sc.day=? AND sc.status='checked' AND sh.end_hour<sh.start_hour`).get(st.id, day - 1).n
      if (has || carriedIn) continue
      const standby = Math.round(st.wage * cfg('standbyRate', 0.3))
      if (standby <= 0) continue
      const pr = db.prepare(`INSERT INTO payroll_entries(code,staff_id,day,kind,standby_pay,amount,tick,note)
                             VALUES(?,?,?, 'standby',?,?,?, '当日无排班，在岗待工补贴')`)
        .run('', st.id, day, standby, standby, ctx.tick())
      const pid = Number(pr.lastInsertRowid)
      db.prepare('UPDATE payroll_entries SET code=? WHERE id=?').run('GZ' + String(pid).padStart(4, '0'), pid)
      setSetting('cash', Math.round(ctx.cash() - standby))
      ctx.logFinance?.(day, '工资', -standby, `${st.name} 第${day}天待工补贴`)
      payable += standby
    }
    return { ok: true, payable }
  })
}

// ---------------- 调班（员工协作：申请 → 主管审批） ----------------
export function requestSwap({ scheduleId, staffId, targetStaffId, reason = '', requestId = '' }) {
  return idempotent('swap_apply', requestId, () => runAtomic(() => {
    const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(scheduleId)
    if (!sc) throw new TxError(SCHED_ERR.NOT_FOUND, '排班不存在')
    if (sc.status !== 'scheduled') throw new TxError(SCHED_ERR.STATUS_CONFLICT, '仅未签到的班次可以申请调班')
    const me = getStaff(staffId)
    const target = getStaff(targetStaffId)
    if (!me || !target) throw new TxError(SCHED_ERR.STAFF_NOT_FOUND, '员工不存在')
    if (!target.active) throw new TxError(SCHED_ERR.STAFF_LEAVE, `${target.name} 已离岗，不能接棒`)
    if (me.id === target.id) throw new TxError(SCHED_ERR.BAD_ARG, '不能与自己调班')
    if (me.role !== target.role) throw new TxError(SCHED_ERR.ROLE_MISMATCH, `调班需同岗位承接（${me.role} → ${target.role}），可请主管改派`)
    const sh = getShift(sc.shift_id)
    const conflict = findConflict(target.id, sc.day, sh, sc.id)
    if (conflict) throw new TxError(SCHED_ERR.CONFLICT, `${target.name} 该时段已有重叠班次，无法接棒`)
    const pend = db.prepare("SELECT id FROM shift_swaps WHERE schedule_id=? AND status='pending'").get(scheduleId)
    if (pend) throw new TxError(SCHED_ERR.PENDING_EXISTS, '该班次已有待审批的调班申请，请勿重复提交')
    if (shiftWindow(sc.day, sh).start <= ctx.tick()) throw new TxError(SCHED_ERR.STATUS_CONFLICT, '班次已开始，不能再申请调班')
    const r = db.prepare(`INSERT INTO shift_swaps(code,schedule_id,staff_id,target_staff_id,reason,status,tick,day)
                          VALUES(?,?,?,?,?, 'pending',?,?)`)
      .run('', sc.id, me.id, target.id, String(reason || '').slice(0, 100), ctx.tick(), ctx.day())
    const id = Number(r.lastInsertRowid)
    db.prepare('UPDATE shift_swaps SET code=? WHERE id=?').run('TB' + String(id).padStart(4, '0'), id)
    logS(sc.id, 'swap_apply', `${me.name} 申请把「${sh.name}」调给 ${target.name}${reason ? `：${reason}` : ''}`, me.id)
    return { ok: true, id, code: 'TB' + String(id).padStart(4, '0') }
  }))
}

export function reviewSwap(id, approve, reviewerId = null, note = '') {
  return runAtomic(() => {
    const sw = db.prepare('SELECT * FROM shift_swaps WHERE id=?').get(id)
    if (!sw) throw new TxError(SCHED_ERR.NOT_FOUND, '调班申请不存在')
    if (sw.status !== 'pending') throw new TxError(SCHED_ERR.STATUS_CONFLICT, '该申请已处理，请勿重复审批')
    const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(sw.schedule_id)
    const me = getStaff(sw.staff_id), target = getStaff(sw.target_staff_id)
    if (!approve) {
      db.prepare("UPDATE shift_swaps SET status='rejected', reviewer_id=?, review_tick=?, review_note=? WHERE id=?")
        .run(reviewerId, ctx.tick(), String(note || '主管驳回').slice(0, 100), id)
      logS(sw.schedule_id, 'swap_reject', `主管驳回 ${me?.name}→${target?.name} 的调班申请`, sw.staff_id, reviewerId)
      return { ok: true }
    }
    if (!sc || sc.status !== 'scheduled') throw new TxError(SCHED_ERR.STATUS_CONFLICT, '原班次状态已变化，无法调班')
    if (!target || !target.active) throw new TxError(SCHED_ERR.STAFF_LEAVE, '接棒员工已离岗，无法调班')
    const sh = getShift(sc.shift_id)
    const conflict = findConflict(target.id, sc.day, sh, sc.id)
    if (conflict) throw new TxError(SCHED_ERR.CONFLICT, `${target.name} 该时段已有重叠班次`)
    // 原子移交：班次换人 + 申请结案
    db.prepare('UPDATE schedules SET staff_id=?, source=? WHERE id=?').run(target.id, 'swap', sc.id)
    db.prepare("UPDATE shift_swaps SET status='approved', reviewer_id=?, review_tick=?, review_note=? WHERE id=?")
      .run(reviewerId, ctx.tick(), String(note || '主管批准').slice(0, 100), id)
    logS(sc.id, 'swap_approve', `主管批准调班：${me?.name} 的「${sh.name}」由 ${target.name} 承接`, target.id, reviewerId)
    return { ok: true }
  })
}

export function cancelSwap(id, staffId) {
  return runAtomic(() => {
    const sw = db.prepare('SELECT * FROM shift_swaps WHERE id=?').get(id)
    if (!sw) throw new TxError(SCHED_ERR.NOT_FOUND, '调班申请不存在')
    if (sw.status !== 'pending') throw new TxError(SCHED_ERR.STATUS_CONFLICT, '已审批的申请不能撤销')
    if (sw.staff_id !== staffId) throw new TxError(SCHED_ERR.BAD_ARG, '仅申请人可撤销调班')
    db.prepare("UPDATE shift_swaps SET status='cancelled', review_tick=?, review_note=? WHERE id=?")
      .run(ctx.tick(), '申请人撤销', id)
    logS(sw.schedule_id, 'swap_cancel', '申请人撤销调班申请', sw.staff_id)
    return { ok: true }
  })
}

// ---------------- 离岗联动 ----------------
// 员工离岗：未开始班次取消、在岗考勤立即签退结算、其相关待审批调班驳回
export function releaseStaffOnLeave(staffId) {
  return runAtomic(() => {
    let settled = 0, cancelled = 0, rejected = 0
    const pend = db.prepare("SELECT * FROM shift_swaps WHERE status='pending' AND (staff_id=? OR target_staff_id=?)").all(staffId, staffId)
    for (const sw of pend) {
      db.prepare("UPDATE shift_swaps SET status='rejected', review_tick=?, review_note=? WHERE id=?")
        .run(ctx.tick(), '相关员工离岗，系统驳回', sw.id)
      logS(sw.schedule_id, 'swap_reject', '相关员工离岗，调班申请自动驳回', sw.staff_id)
      rejected++
    }
    const scheds = db.prepare("SELECT * FROM schedules WHERE staff_id=? AND status IN ('scheduled','checked')").all(staffId)
    for (const sc of scheds) {
      const sh = getShift(sc.shift_id)
      const w = shiftWindow(sc.day, sh)
      if (sc.status === 'checked') {
        const att = db.prepare("SELECT * FROM attendances WHERE id=? AND status='checked_in'").get(sc.attendance_id)
        // 已产生至少 1 个游戏小时在岗：按当前时刻立即签退结算；当 tick 刚签到（0 工时）则视同未开始取消
        if (att && ctx.tick() >= att.checkin_tick + 1) {
          settleAtTick(sc, att, sh, Math.min(ctx.tick(), w.end))
          settled++
          continue
        }
      }
      db.prepare("UPDATE schedules SET status='cancelled' WHERE id=?").run(sc.id)
      logS(sc.id, 'leave', `员工离岗，未开始班次「${sh.name}」取消`, staffId)
      cancelled++
    }
    return { ok: true, settled, cancelled, rejected }
  })
}

// ---------------- 岗位在岗回调（检修/投诉引擎用） ----------------
// 当前 tick 是否处于已签到考勤时段内（下班 tick 起不在岗）
export function isStaffOnDuty(staffId) {
  const tick = ctx.tick()
  const row = db.prepare(`SELECT att.id, att.checkin_tick, sc.day, sh.start_hour, sh.end_hour FROM attendances att
                          JOIN schedules sc ON sc.id=att.schedule_id
                          JOIN shift_types sh ON sh.id=sc.shift_id
                          WHERE att.staff_id=? AND att.status='checked_in'`).get(staffId)
  if (!row) return false
  const w = shiftWindow(row.day, row)
  return tick >= row.checkin_tick && tick < w.end
}

// 完工回写：检修/投诉处置完成时把有效作业分钟与满意度变化写到当前考勤
export function addWorkMinutes(staffId, minutes, { kind = 'work', morale = 0, refId = null } = {}) {
  const st = getStaff(staffId)
  if (!st) return null
  const row = db.prepare(`SELECT att.* FROM attendances att
                          WHERE att.staff_id=? AND att.status='checked_in' ORDER BY att.id DESC LIMIT 1`).get(staffId)
  let attendanceId = row?.id || null
  if (row) db.prepare('UPDATE attendances SET work_minutes=work_minutes+? WHERE id=?').run(Math.round(num(minutes)), row.id)
  if (morale) db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.max(20, Math.min(100, st.morale + morale)), st.id)
  return { attendanceId, kind, refId, morale }
}

// ---------------- 查询 ----------------
function enrichSchedule(sc) {
  const st = getStaff(sc.staff_id)
  const sh = getShift(sc.shift_id)
  const att = sc.attendance_id ? db.prepare('SELECT * FROM attendances WHERE id=?').get(sc.attendance_id) : null
  const payroll = sc.payroll_id ? db.prepare('SELECT * FROM payroll_entries WHERE id=?').get(sc.payroll_id) : null
  const win = sh ? shiftWindow(sc.day, sh) : null
  return {
    ...sc,
    staff_name: st?.name || '',
    role: st?.role || '',
    staff_active: st ? !!st.active : false,
    shift_name: sh?.name || '',
    start_hour: sh?.start_hour ?? 0,
    end_hour: sh?.end_hour ?? 0,
    cross: win?.cross || false,
    planned_minutes: sh ? plannedMinutesOf(sh) : 0,
    attendance: att ? {
      ...att,
      worked_hours: Math.round((att.worked_minutes || 0) / 6) / 10,
      work_hours: Math.round((att.work_minutes || 0) / 6) / 10,
      overtime_hours: Math.round((att.overtime_minutes || 0) / 6) / 10
    } : null,
    payroll
  }
}

export function listSchedules({ day = null, staffId = null, status = null, limit = 300 } = {}) {
  const where = [], vals = []
  if (day) { where.push('day=?'); vals.push(day) }
  if (staffId) { where.push('staff_id=?'); vals.push(staffId) }
  if (status) { where.push('status=?'); vals.push(status) }
  const sql = `SELECT * FROM schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY day DESC, id DESC LIMIT ?`
  vals.push(limit)
  return db.prepare(sql).all(...vals).map(enrichSchedule)
}

export function scheduleDetail(id) {
  const sc = db.prepare('SELECT * FROM schedules WHERE id=?').get(id)
  if (!sc) return null
  const logs = db.prepare('SELECT * FROM schedule_logs WHERE schedule_id=? ORDER BY id').all(id)
  return { schedule: enrichSchedule(sc), logs }
}

export function listSwaps({ status = null } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM shift_swaps WHERE status=? ORDER BY id DESC LIMIT 200').all(status)
    : db.prepare('SELECT * FROM shift_swaps ORDER BY id DESC LIMIT 200').all()
  return rows.map(sw => {
    const sc = db.prepare('SELECT sc.*, sh.name shift_name FROM schedules sc JOIN shift_types sh ON sh.id=sc.shift_id WHERE sc.id=?').get(sw.schedule_id)
    const me = getStaff(sw.staff_id), tg = getStaff(sw.target_staff_id), rv = sw.reviewer_id ? getStaff(sw.reviewer_id) : null
    return { ...sw, staff_name: me?.name || '', target_name: tg?.name || '', reviewer_name: rv?.name || '', day: sc?.day || sw.day, shift_name: sc?.shift_name || '' }
  })
}

export function listPayroll({ day = null, staffId = null, limit = 200 } = {}) {
  const where = [], vals = []
  if (day) { where.push('day=?'); vals.push(day) }
  if (staffId) { where.push('staff_id=?'); vals.push(staffId) }
  const sql = `SELECT * FROM payroll_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  vals.push(limit)
  return db.prepare(sql).all(...vals).map(p => ({ ...p, staff_name: getStaff(p.staff_id)?.name || '', role: getStaff(p.staff_id)?.role || '' }))
}

export function scheduleLogs(limit = 60) {
  return db.prepare(`SELECT l.*, st.name staff_name FROM schedule_logs l
                     LEFT JOIN staff st ON st.id=l.staff_id ORDER BY l.id DESC LIMIT ?`).all(limit).reverse()
}

export function scheduleStats() {
  const day = ctx.day()
  const today = db.prepare('SELECT COUNT(*) n FROM schedules WHERE day=?').get(day).n
  const checked = db.prepare("SELECT COUNT(*) n FROM schedules WHERE day=? AND status='checked'").get(day).n
  const missing = db.prepare("SELECT COUNT(*) n FROM schedules WHERE day=? AND status='missed'").get(day).n
  const pendingSwaps = db.prepare("SELECT COUNT(*) n FROM shift_swaps WHERE status='pending'").get().n
  const overtimeToday = db.prepare('SELECT COALESCE(SUM(overtime_minutes),0) m, COUNT(*) n FROM payroll_entries WHERE day=? AND overtime_minutes>0').get(day)
  const payrollToday = db.prepare('SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM payroll_entries WHERE day=?').get(day)
  const coverage = coverageForDay(day)
  return {
    today, checked, missing, pendingSwaps,
    overtimeStaff: overtimeToday.n,
    overtimeMinutes: overtimeToday.m,
    payrollToday: payrollToday.s,
    payrollCount: payrollToday.n,
    coverageMissing: coverage.missing
  }
}
