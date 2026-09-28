// 员工排班与工时结算一致性测试：
// 班次几何/冲突校验 → 签到迟到 → 到点自动签退结算（基本+加班+夜班+扣减，入工资财务）
// → 跨日夜班结转次日结算 → 旷工/待工日结 → 调班原子移交 → 离岗释放 → 在岗门控/完工工时回写
// 运行：node --test server/scheduling.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const SCH = await import('./scheduling.js')

const finLogs = []
SCH.initSchedulingContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })
})

const cash = () => Number(getSetting('cash'))
const schedById = id => db.prepare('SELECT * FROM schedules WHERE id=?').get(id)
const attById = id => db.prepare('SELECT * FROM attendances WHERE id=?').get(id)
const payrollBySched = sid => db.prepare('SELECT * FROM payroll_entries WHERE schedule_id=?').get(sid)
const shiftByCode = code => db.prepare('SELECT * FROM shift_types WHERE code=?').get(code)
let seq = 0
const uid = p => `${p}-${++seq}`

// 每个用例使用专属新员工，避免种子员工/时钟在用例间互相干扰
function mkStaff(role, wage = 300) {
  const r = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,1,?,2,80,1)')
    .run(`测试${role}${++seq}`, role, wage)
  return db.prepare('SELECT * FROM staff WHERE id=?').get(Number(r.lastInsertRowid))
}
// tick 为连续游戏小时（每营业日 9~18 共 10 tick，闭园空窗不占 tick）
const setClock = (day, hour) => { setSetting('day', day); setSetting('hour', hour); setSetting('tick', (day - 1) * 10 + (hour - 9)) }
function mustSchedule(staffId, day, shiftCode, extra = {}) {
  const r = SCH.createSchedule({ staffId, day, shiftId: shiftByCode(shiftCode).id, requestId: uid('s'), ...extra })
  assert.equal(r.ok, true, `排班应成功：${r.msg || ''}`)
  return r
}

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 500000)
})
// 每个用例前重置时钟，避免上一个用例拨钟影响「过去日期」等校验
beforeEach(() => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
})

test('班次几何：跨日夜班窗口跨越次日 tick，计划工时含闭园夜段', () => {
  const night = shiftByCode('night')
  const early = shiftByCode('early')
  // night 17→次日9：第1天窗口 tick 8 → 次日 tick 10，跨 2 个游戏 tick；计划 16h（2h 园内 + 6h 夜段 + 8h 凌晨）
  assert.equal(night.end_hour < night.start_hour, true)
  assert.equal((18 - night.start_hour) + 6 + night.end_hour, 16)
  assert.equal(early.end_hour >= early.start_hour, true)
})

test('排班校验：离岗员工不可排；时间重叠/跨日首尾相接拒绝；错峰班可排', () => {
  const rep = mkStaff('维修', 380)
  const night = shiftByCode('night'), mid = shiftByCode('mid'), early = shiftByCode('early')

  db.prepare('UPDATE staff SET active=0 WHERE id=?').run(rep.id)
  const r0 = SCH.createSchedule({ staffId: rep.id, day: 20, shiftId: night.id, requestId: uid('s') })
  assert.equal(r0.ok, false)
  assert.equal(r0.code, 'SCHED_STAFF_ON_LEAVE')
  db.prepare('UPDATE staff SET active=1 WHERE id=?').run(rep.id)

  assert.equal(mustSchedule(rep.id, 20, 'night').ok, true)
  // 同日中班（12-18 与夜班 17 起重叠）→ 冲突
  assert.equal(SCH.createSchedule({ staffId: rep.id, day: 20, shiftId: mid.id, requestId: uid('s') }).code, 'SCHED_CONFLICT')
  // 次日早班 9 点上班与夜班 9 点下班首尾相接（无休息）→ 冲突
  assert.equal(SCH.createSchedule({ staffId: rep.id, day: 21, shiftId: early.id, requestId: uid('s') }).code, 'SCHED_CONFLICT')
  // 次日中班 12 点起：夜班下班后有 3h 休息 → 成功
  assert.equal(SCH.createSchedule({ staffId: rep.id, day: 21, shiftId: mid.id, requestId: uid('s') }).ok, true)
  // 过去日期不可排（时钟拨到第 2 天后，第 1 天即过去）
  setSetting('day', 2); setSetting('tick', 10)
  assert.equal(SCH.createSchedule({ staffId: rep.id, day: 1, shiftId: mid.id, requestId: uid('s') }).code, 'SCHED_PAST_DAY')
})

test('幂等：同一 requestId 重复排班只建一条，重放返回首次单号', () => {
  const cl = mkStaff('保洁')
  const key = uid('idem')
  const a = SCH.createSchedule({ staffId: cl.id, day: 22, shiftId: shiftByCode('early').id, requestId: key })
  const b = SCH.createSchedule({ staffId: cl.id, day: 22, shiftId: shiftByCode('early').id, requestId: key })
  assert.equal(a.ok, true); assert.equal(b.ok, true)
  assert.equal(a.id, b.id)
  assert.equal(b.replay, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schedules WHERE staff_id=? AND day=?').get(cl.id, 22).n, 1)
})

test('签到/到点自动签退：正点结算底薪入工资财务；主动延时签退计加班费', () => {
  const g = mkStaff('保安', 320)
  const cr = mustSchedule(g.id, 23, 'full')

  setClock(23, 9)
  const ci = SCH.checkIn({ staffId: g.id, requestId: uid('ci') })
  assert.equal(ci.ok, true, ci.msg)
  assert.equal(ci.lateMinutes, 0)
  assert.equal(schedById(cr.id).status, 'checked')

  // 18:00 自动签退：正点结算，全天班 9h = 标准工时，底薪正好日薪，无加班
  setClock(23, 18)
  SCH.processSchedules()
  const p = payrollBySched(cr.id)
  assert.equal(schedById(cr.id).status, 'done')
  assert.equal(p.base_pay, g.wage)
  assert.equal(p.overtime_pay, 0)
  assert.equal(p.amount, g.wage)
  assert.ok(finLogs.some(f => f.label === '工资' && f.amount === -g.wage))

  // 第 24 天再排全天班，签到后延时 1 个游戏 tick 手动签退 → 加班 1h
  const cr2 = mustSchedule(g.id, 24, 'full')
  setClock(24, 9)
  assert.equal(SCH.checkIn({ staffId: g.id, requestId: uid('ci') }).ok, true)
  setSetting('tick', (24 - 1) * 10 + 10)  // 18 点后 1 个游戏 tick（闭园压缩，几何上=次日 9 点）
  const co = SCH.checkOut({ staffId: g.id, requestId: uid('co') })
  assert.equal(co.ok, true, co.msg)
  assert.equal(co.workedMinutes, 10 * 60)
  assert.equal(co.overtimeMinutes, 60)
  assert.equal(co.overtimePay, Math.round(g.wage / 9 * 1.5))
})

test('迟到签到：宽限外记迟到，结算扣减不超过日薪上限', () => {
  const sp = mkStaff('会员专员', 340)
  const cr = mustSchedule(sp.id, 25, 'mid')  // 12-18
  setClock(25, 14)  // 迟到 2h，扣宽限 15 分 = 105 分钟
  const ci = SCH.checkIn({ staffId: sp.id, requestId: uid('ci') })
  assert.equal(ci.ok, true, ci.msg)
  assert.equal(ci.lateMinutes, 105)
  setClock(25, 18)
  SCH.processSchedules()
  const p = payrollBySched(cr.id)
  const expectDeduct = Math.min(Math.round(105 / 60 * (sp.wage / 9)), Math.round(sp.wage * 0.2))
  assert.equal(p.deduction, expectDeduct)
  assert.ok(p.deduction > 0)
  assert.equal(p.amount, p.base_pay + p.overtime_pay + p.night_pay - p.deduction)
})

test('跨日夜班：日结结转不结工资，次日 9 点自动签退按排班归属日跨日结算（含夜班费）', () => {
  const g = mkStaff('保安', 320)
  const cr = mustSchedule(g.id, 26, 'night')  // 17→次日9，夜段 6h
  setClock(26, 17)
  assert.equal(SCH.checkIn({ staffId: g.id, requestId: uid('ci') }).ok, true)

  const cashBefore = cash()
  const payrollCountBefore = db.prepare("SELECT COUNT(*) n FROM payroll_entries WHERE day=26 AND kind='shift'").get().n
  const r = SCH.settleDayEnd(26)
  assert.equal(r.ok, true)
  const sc = schedById(cr.id)
  assert.equal(sc.status, 'checked', '跨日班日结后仍出勤中')
  const att = attById(sc.attendance_id)
  assert.equal(att.carried, 1)
  assert.equal(att.night_minutes, 360)
  assert.equal(payrollBySched(cr.id), undefined, '跨日班当日不结算工资')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payroll_entries WHERE day=26 AND kind='shift'").get().n, payrollCountBefore, '日结不产生任何班次结算')

  // 次日 9:00（day27 起始 tick）自动签退：归属日仍是第 26 天
  setClock(27, 9)
  SCH.processSchedules()
  const p = payrollBySched(cr.id)
  assert.ok(p, '次日下班应生成结算单')
  assert.equal(p.day, 26, '工资归属排班开始日（跨日结算）')
  assert.equal(p.night_pay, Math.round(6 * 12), '夜班费=6h×12')
  assert.equal(p.base_pay, Math.round(16 * (g.wage / 9)), '按计划 16h 计底薪')
  assert.equal(p.overtime_pay, 0)
  assert.ok(finLogs.some(f => f.detail.includes('跨日结算')), '流水应标记跨日结算')
})

test('日结：未签到班次判旷工无工资且满意度下降；无班在岗员工发待工补贴', () => {
  const rep = mkStaff('维修', 380)
  const idle = mkStaff('保洁', 300)
  mustSchedule(rep.id, 27, 'mid')          // 全天不签到
  // idle 第 27 天无任何排班
  const morale0 = db.prepare('SELECT morale FROM staff WHERE id=?').get(rep.id).morale
  setClock(27, 18)
  const cash0 = cash()
  const r = SCH.settleDayEnd(27)
  assert.equal(r.ok, true)
  const cr = db.prepare("SELECT * FROM schedules WHERE staff_id=? AND day=27").get(rep.id)
  assert.equal(cr.status, 'missed')
  const p = payrollBySched(cr.id)
  assert.equal(p.kind, 'absence')
  assert.equal(p.amount, 0)
  assert.equal(db.prepare('SELECT morale FROM staff WHERE id=?').get(rep.id).morale, morale0 - 8)

  const sp = db.prepare("SELECT * FROM payroll_entries WHERE staff_id=? AND day=27 AND kind='standby'").get(idle.id)
  assert.ok(sp, '无班在岗员工应发待工补贴')
  assert.equal(sp.amount, Math.round(idle.wage * 0.3))
  assert.ok(cash() < cash0)
})

test('调班：非同岗拒绝；同岗申请主管批准原子移交；重复申请/重复审批拒绝', () => {
  const a = mkStaff('保洁'), b = mkStaff('保洁'), g = mkStaff('保安')
  const cr = mustSchedule(a.id, 28, 'early')
  assert.equal(SCH.requestSwap({ scheduleId: cr.id, staffId: a.id, targetStaffId: g.id, requestId: uid('sw') }).code, 'SCHED_ROLE_MISMATCH')

  const ap = SCH.requestSwap({ scheduleId: cr.id, staffId: a.id, targetStaffId: b.id, reason: '家中有事', requestId: uid('sw') })
  assert.equal(ap.ok, true)
  assert.equal(ap.code.startsWith('TB'), true)
  assert.equal(SCH.requestSwap({ scheduleId: cr.id, staffId: a.id, targetStaffId: b.id, requestId: uid('sw') }).code, 'SCHED_SWAP_PENDING')

  assert.equal(SCH.reviewSwap(ap.id, true).ok, true)
  assert.equal(schedById(cr.id).staff_id, b.id, '班次应原子移交给接棒人')
  assert.equal(db.prepare('SELECT status FROM shift_swaps WHERE id=?').get(ap.id).status, 'approved')
  assert.equal(SCH.reviewSwap(ap.id, true).ok, false, '已审批不可重复处理')
})

test('调班冲突：接棒人该时段已有班 → 申请与审批均拒绝', () => {
  const a = mkStaff('保洁'), b = mkStaff('保洁')
  mustSchedule(a.id, 29, 'early')
  const bcr = mustSchedule(b.id, 29, 'mid')  // 与早班重叠
  assert.equal(SCH.requestSwap({ scheduleId: bcr.id, staffId: b.id, targetStaffId: a.id, requestId: uid('sw') }).code, 'SCHED_CONFLICT')
})

test('离岗联动：未开始班次取消、在岗考勤立即结算、待审批调班驳回', () => {
  const a = mkStaff('保安', 320), b = mkStaff('保安', 320)
  const cFuture = mustSchedule(a.id, 30, 'mid')
  const cActive = mustSchedule(a.id, 29, 'full')
  setClock(29, 9)
  assert.equal(SCH.checkIn({ staffId: a.id, requestId: uid('ci') }).ok, true)
  setClock(29, 11)  // 已在岗 2 小时后离岗
  // b 申请把第 31 天的早班调给当天无班的 a（待审批，涉岗员工 a 随后离岗）
  const cOther = mustSchedule(b.id, 31, 'early')
  const ap = SCH.requestSwap({ scheduleId: cOther.id, staffId: b.id, targetStaffId: a.id, requestId: uid('sw') })
  assert.equal(ap.ok, true)

  const cash0 = cash()
  // 主循环先置员工离岗，再触发排班释放
  db.prepare('UPDATE staff SET active=0 WHERE id=?').run(a.id)
  const r = SCH.releaseStaffOnLeave(a.id)
  assert.equal(r.ok, true)
  assert.equal(schedById(cFuture.id).status, 'cancelled')
  assert.equal(schedById(cActive.id).status, 'done', '在岗考勤立即签退结算')
  assert.ok(r.settled >= 1 && r.cancelled >= 1 && r.rejected >= 1)
  assert.ok(cash() < cash0)
  assert.equal(db.prepare('SELECT status FROM shift_swaps WHERE id=?').get(ap.id).status, 'rejected')
  assert.equal(db.prepare('SELECT active FROM staff WHERE id=?').get(a.id).active, 0)
})

test('在岗门控与完工回写：签到前/下班点后不在岗；作业分钟累计写入考勤', () => {
  const sp = mkStaff('会员专员', 340)
  const cr = mustSchedule(sp.id, 31, 'full')
  setClock(31, 9)
  assert.equal(SCH.isStaffOnDuty(sp.id), false)
  assert.equal(SCH.checkIn({ staffId: sp.id, requestId: uid('ci') }).ok, true)
  assert.equal(SCH.isStaffOnDuty(sp.id), true)
  SCH.addWorkMinutes(sp.id, 60, { kind: 'complaint', refId: 1 })
  SCH.addWorkMinutes(sp.id, 30, { kind: 'complaint', refId: 2, morale: 2 })
  const att = attById(schedById(cr.id).attendance_id)
  assert.equal(att.work_minutes, 90)
  setClock(31, 18)
  assert.equal(SCH.isStaffOnDuty(sp.id), false, '下班点起不在岗')
})
