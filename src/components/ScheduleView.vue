<script setup>
import { ref, computed } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()

const tabs = [
  { k: 'board', label: '排班日历' },
  { k: 'attendance', label: '考勤签到' },
  { k: 'swaps', label: '调班审批' },
  { k: 'payroll', label: '工时工资' },
  { k: 'settings', label: '班次/结算配置' }
]
const tab = ref('board')

// ---------------- 排班日历 ----------------
const viewDay = ref(store.clock.day)
const selectDay = d => { viewDay.value = d }

const daySchedules = computed(() =>
  store.schedules.filter(s => s.day === viewDay.value))

const coverage = computed(() => {
  // /state 未携带逐日覆盖，前端按排班+在途检修/投诉汇总近似展示
  const rows = daySchedules.value.filter(s => ['scheduled', 'checked'].includes(s.status))
  const roleHave = {}
  for (const s of rows) roleHave[s.role] = (roleHave[s.role] || 0) + 1
  const openOrders = store.maintenanceOrders.filter(o => ['queued', 'processing'].includes(o.status)).length
  const needRoles = { '保安': 1, '保洁': 1, '维修': openOrders > 0 ? 1 : 0 }
  for (const c of store.openComplaints) {
    const map = { queue: '保安', hygiene: '保洁', facility: '维修', safety: '保安', food: '保洁', missing: '保安' }
    const role = map[c.category]
    if (role) needRoles[role] = (needRoles[role] || 0) + 1
  }
  return Object.entries(needRoles).map(([role, need]) => ({ role, need, have: roleHave[role] || 0 }))
    .filter(r => r.need > 0)
})

const STATUS_META = {
  scheduled: { label: '已排班', cls: 'st-sched' },
  checked: { label: '出勤中', cls: 'st-on' },
  done: { label: '已结算', cls: 'st-done' },
  missed: { label: '旷工', cls: 'st-miss' },
  cancelled: { label: '已取消', cls: 'st-cancel' }
}

const form = ref({ staff_id: '', shift_id: '' })
const formMsg = ref('')
async function submitSchedule() {
  if (!form.value.staff_id || !form.value.shift_id) { formMsg.value = '请选择员工与班次'; return }
  const r = await store.createSchedule({ staff_id: +form.value.staff_id, shift_id: +form.value.shift_id, day: viewDay.value })
  formMsg.value = r?.ok ? `已排班 ${r.code}` : (r?.msg || '排班失败')
  if (r?.ok) form.value.shift_id = ''
}

const reassignTo = ref({})
async function reassign(s) {
  const sid = reassignTo.value[s.id]
  if (!sid) return
  await store.reassignSchedule(s.id, +sid)
}

// ---------------- 考勤签到（员工协作） ----------------
const activeStaff = computed(() => store.staff.filter(s => s.active))
const attStaffId = ref(null)
const attMsg = ref('')

// 员工今日/跨日在途班次
function staffOpenSchedules(staffId) {
  return store.schedules.filter(s =>
    s.staff_id === staffId &&
    (s.day === store.clock.day || s.day === store.clock.day - 1) &&
    ['scheduled', 'checked'].includes(s.status))
}
const mySchedules = computed(() => attStaffId.value ? staffOpenSchedules(+attStaffId.value) : [])

const checkedInIds = computed(() => new Set(
  store.schedules.filter(s => s.status === 'checked').map(s => s.staff_id)
))

async function checkin() {
  if (!attStaffId.value) { attMsg.value = '请选择员工（模拟员工本人操作）'; return }
  const r = await store.checkIn(+attStaffId.value)
  attMsg.value = r?.ok ? `签到成功：${r.shift}${r.lateMinutes ? `，迟到 ${r.lateMinutes} 分钟` : ''}` : (r?.msg || '签到失败')
}
async function checkout() {
  if (!attStaffId.value) return
  const r = await store.checkOut(+attStaffId.value)
  attMsg.value = r?.ok
    ? `签退结算成功：在岗 ${(r.workedMinutes / 60).toFixed(1)}h${r.overtimeMinutes ? `，加班 ${(r.overtimeMinutes / 60).toFixed(1)}h` : ''}，应发 ¥${r.amount}`
    : (r?.msg || '签退失败')
}

// ---------------- 调班 ----------------
const swapForm = ref({ schedule_id: '', target_staff_id: '', reason: '' })
const swapMsg = ref('')
async function applySwap() {
  if (!swapForm.value.schedule_id || !swapForm.value.target_staff_id) { swapMsg.value = '请选择班次与换班对象'; return }
  const sc = store.schedules.find(x => x.id === +swapForm.value.schedule_id)
  const r = await store.requestSwap({
    schedule_id: +swapForm.value.schedule_id,
    staff_id: sc?.staff_id,
    target_staff_id: +swapForm.value.target_staff_id,
    reason: swapForm.value.reason
  })
  swapMsg.value = r?.ok ? `调班申请 ${r.code} 已提交，等待主管审批` : (r?.msg || '申请失败')
  if (r?.ok) swapForm.value = { schedule_id: '', target_staff_id: '', reason: '' }
}

const swappableSchedules = computed(() =>
  store.schedules.filter(s => s.status === 'scheduled' && s.day >= store.clock.day))

async function review(sw, approve) {
  await store.reviewSwap(sw.id, approve, approve ? '主管批准' : '主管驳回')
}
async function cancelSwapReq(sw) {
  await store.cancelSwap(sw.id, sw.staff_id)
}

const SWAP_META = {
  pending: { label: '待审批', cls: 'st-sched' },
  approved: { label: '已批准', cls: 'st-done' },
  rejected: { label: '已驳回', cls: 'st-miss' },
  cancelled: { label: '已撤销', cls: 'st-cancel' }
}

// ---------------- 工时工资 ----------------
const payrollDay = ref(0)   // 0 = 全部
const payrollList = computed(() =>
  payrollDay.value ? store.payroll.filter(p => p.day === payrollDay.value) : store.payroll)
const payrollSum = computed(() => payrollList.value.reduce((s, p) => s + p.amount, 0))
const KIND_META = {
  shift: { label: '班次结算', cls: 'tag' },
  standby: { label: '待工补贴', cls: 'tag warn' },
  absence: { label: '旷工', cls: 'tag bad' }
}

// ---------------- 班次/结算配置（主管） ----------------
const cfgForm = ref({ ...store.scheduleConfig })
const cfgMsg = ref('')
async function saveCfg() {
  const r = await store.saveScheduleConfig(cfgForm.value)
  cfgMsg.value = r?.ok ? '结算参数已保存' : (r?.msg || '保存失败')
}
async function saveShift(sh, patch) {
  await store.updateShiftType(sh.id, patch)
}

const LOG_LABEL = {
  create: '主管排班', auto: '自动铺班', reassign: '主管改派', cancel: '取消排班',
  checkin: '签到', late: '迟到签到', checkout: '签退结算', carry: '跨日结转',
  settle: '工时结算', missing: '旷工判定', swap_apply: '申请调班', swap_approve: '批准调班',
  swap_reject: '驳回调班', swap_cancel: '撤销调班', leave: '离岗释放'
}

function shiftTime(s) {
  return `${String(s.start_hour).padStart(2, '0')}:00–${String(s.end_hour).padStart(2, '0')}:00${s.cross ? ' 次日' : ''}`
}
</script>

<template>
  <div class="sched">
    <!-- 顶部统计 -->
    <div class="stat-grid">
      <div class="card stat"><span>📅</span><b>{{ store.scheduleStats.today }}</b><em>今日班次</em></div>
      <div class="card stat"><span>✅</span><b>{{ store.scheduleStats.checked }}</b><em>出勤中</em></div>
      <div class="card stat" :class="{ alert: store.scheduleStats.missing }"><span>⚠️</span><b :class="{ neg: store.scheduleStats.missing }">{{ store.scheduleStats.missing }}</b><em>今日旷工</em></div>
      <div class="card stat" :class="{ alert: store.scheduleStats.pendingSwaps }"><span>🔁</span><b>{{ store.scheduleStats.pendingSwaps }}</b><em>调班待审批</em></div>
      <div class="card stat"><span>🕒</span><b>{{ (store.scheduleStats.overtimeMinutes / 60).toFixed(1) }}h</b><em>今日加班</em></div>
      <div class="card stat"><span>💰</span><b class="money neg">¥{{ store.scheduleStats.payrollToday.toLocaleString() }}</b><em>今日已结工资</em></div>
    </div>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
    </div>

    <!-- ============ 排班日历 ============ -->
    <template v-if="tab === 'board'">
      <div class="bar">
        <div class="days">
          <button v-for="d in [store.clock.day - 1, store.clock.day, store.clock.day + 1, store.clock.day + 2]" :key="d"
                  class="daybtn" :class="{ on: viewDay === d, past: d < store.clock.day }" @click="selectDay(d)">
            <em>第 {{ d }} 天</em>
            <b>{{ d === store.clock.day ? '今天' : d < store.clock.day ? '昨天' : d === store.clock.day + 1 ? '明天' : '后天' }}</b>
            <i v-if="store.schedules.some(s => s.day === d && s.status === 'missed')" class="miss-dot">!</i>
          </button>
        </div>
      </div>

      <div class="card coverage">
        <h3>🛡️ 岗位覆盖校验（设施检修 / 投诉处置）</h3>
        <div v-if="!coverage.length" class="muted">当日所需岗位（保安/保洁/维修）均有排班覆盖。</div>
        <div v-for="r in coverage" :key="r.role" class="cov" :class="{ gap: r.have < r.need }">
          <b>{{ r.role }}</b>
          <span>需求 {{ r.need }} 人 · 已排 {{ r.have }} 人</span>
          <em v-if="r.have < r.need" class="neg">缺 {{ r.need - r.have }} 人（在途检修工单/投诉处置可能暂停）</em>
          <em v-else class="ok">已覆盖</em>
        </div>
      </div>

      <div class="card newshift">
        <h3>➕ 新增排班</h3>
        <select v-model="form.staff_id">
          <option value="" disabled>选择员工</option>
          <option v-for="s in activeStaff" :key="s.id" :value="s.id">{{ s.name }} · {{ s.role }} · Lv.{{ s.skill }}</option>
        </select>
        <select v-model="form.shift_id">
          <option value="" disabled>选择班次</option>
          <option v-for="sh in store.shiftTypes.filter(x => x.active)" :key="sh.id" :value="sh.id">
            {{ sh.name }} {{ String(sh.start_hour).padStart(2,'0') }}:00–{{ String(sh.end_hour).padStart(2,'0') }}:00{{ sh.end_hour < sh.start_hour ? '（跨日夜班）' : '' }}
          </option>
        </select>
        <button class="primary" @click="submitSchedule">排上</button>
        <span class="msg" :class="{ err: formMsg && !formMsg.startsWith('已') }">{{ formMsg }}</span>
      </div>

      <div class="table card">
        <div class="thead"><span>员工</span><span>岗位</span><span>班次</span><span>时间</span><span>状态/考勤</span><span>工时</span><span>改派</span><span>操作</span></div>
        <div class="trow" v-for="s in daySchedules" :key="s.id">
          <span><b>{{ s.staff_name }}</b><em v-if="!s.staff_active" class="neg">（已离岗）</em></span>
          <span>{{ s.role }}</span>
          <span>{{ s.shift_name }}</span>
          <span class="time">{{ shiftTime(s) }}</span>
          <span>
            <i class="tag" :class="STATUS_META[s.status]?.cls">{{ STATUS_META[s.status]?.label || s.status }}</i>
            <em v-if="s.attendance?.late_minutes" class="neg">迟到 {{ s.attendance.late_minutes }}分</em>
            <em v-else-if="s.attendance?.work_hours" class="muted">作业 {{ s.attendance.work_hours }}h</em>
          </span>
          <span>
            <template v-if="s.attendance?.worked_hours">{{ s.attendance.worked_hours }}h<span v-if="s.attendance.overtime_hours" class="ot"> ·加{{ s.attendance.overtime_hours }}h</span></template>
            <template v-else-if="s.payroll">已结</template>
            <span v-else class="muted">—</span>
          </span>
          <span>
            <select v-model="reassignTo[s.id]" :disabled="s.status !== 'scheduled'">
              <option value="">改派给…</option>
              <option v-for="t in activeStaff.filter(x => x.id !== s.staff_id && x.role === s.role)" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
            <button class="ghost sm" v-if="s.status === 'scheduled' && reassignTo[s.id]" @click="reassign(s)">确定</button>
          </span>
          <span>
            <button class="danger sm" v-if="s.status === 'scheduled'" @click="store.cancelSchedule(s.id)">取消</button>
            <span v-else-if="s.payroll" class="money neg">¥{{ s.payroll.amount }}</span>
          </span>
        </div>
        <div class="muted empty" v-if="!daySchedules.length">第 {{ viewDay }} 天暂无排班，系统会在当天自动铺班，也可手动新增。</div>
      </div>
    </template>

    <!-- ============ 考勤签到 ============ -->
    <template v-else-if="tab === 'attendance'">
      <div class="card kiosk">
        <h3>🧑‍💼 员工考勤（员工本人 / 前台代操作）</h3>
        <select v-model="attStaffId">
          <option :value="null" disabled>选择员工</option>
          <option v-for="s in activeStaff" :key="s.id" :value="s.id">
            {{ s.name }} · {{ s.role }}{{ checkedInIds.has(s.id) ? ' · 出勤中' : '' }}
          </option>
        </select>
        <button class="primary" :disabled="!attStaffId || checkedInIds.has(attStaffId)" @click="checkin">上班签到</button>
        <button class="succ" :disabled="!attStaffId || !checkedInIds.has(attStaffId)" @click="checkout">下班签退结算</button>
        <span class="msg" :class="{ err: attMsg && !attMsg.includes('成功') }">{{ attMsg }}</span>
        <div class="muted tip">签到超过宽限（{{ store.scheduleConfig.lateGrace }} 分钟）记迟到并按比例扣薪；到下班点系统自动签退正点结算，主动延时签退计加班费（{{ store.scheduleConfig.overtimeRate }}× 时薪）。</div>

        <div v-if="mySchedules.length" class="myshifts">
          <div v-for="s in mySchedules" :key="s.id" class="ms card">
            <b>{{ s.shift_name }}</b>
            <span>{{ shiftTime(s) }}</span>
            <i class="tag" :class="STATUS_META[s.status]?.cls">{{ STATUS_META[s.status]?.label }}</i>
            <span v-if="s.attendance" class="muted">
              在岗 {{ s.attendance.worked_hours }}h · 计划 {{ (s.planned_minutes / 60).toFixed(0) }}h
              <template v-if="s.attendance.work_minutes">· 有效作业 {{ s.attendance.work_hours }}h</template>
            </span>
          </div>
        </div>
      </div>

      <div class="table card">
        <div class="thead"><span>员工</span><span>岗位</span><span>今日/在途班次</span><span>签到</span><span>在岗工时</span><span>作业工时</span><span>加班</span><span>夜班</span></div>
        <div class="trow" v-for="s in activeStaff" :key="s.id">
          <span><b>{{ s.name }}</b></span>
          <span>{{ s.role }}</span>
          <span>
            <template v-for="sc in staffOpenSchedules(s.id)" :key="sc.id">
              <i class="tag" :class="STATUS_META[sc.status]?.cls">{{ sc.shift_name }}</i>
            </template>
            <span v-if="!staffOpenSchedules(s.id).length" class="muted">休/待工</span>
          </span>
          <span>
            <template v-for="sc in staffOpenSchedules(s.id).filter(x => x.attendance)" :key="sc.id">
              <em :class="{ neg: sc.attendance.late_minutes }">{{ sc.attendance.late_minutes ? `迟到${sc.attendance.late_minutes}分` : '准时' }}</em>
            </template>
          </span>
          <span>{{ staffOpenSchedules(s.id).reduce((a, x) => a + (x.attendance?.worked_hours || 0), 0).toFixed(1) }}h</span>
          <span>{{ staffOpenSchedules(s.id).reduce((a, x) => a + (x.attendance?.work_hours || 0), 0).toFixed(1) }}h</span>
          <span>{{ staffOpenSchedules(s.id).reduce((a, x) => a + (x.attendance?.overtime_hours || 0), 0).toFixed(1) }}h</span>
          <span>{{ (staffOpenSchedules(s.id).reduce((a, x) => a + (x.attendance?.night_minutes || 0), 0) / 60).toFixed(1) }}h</span>
        </div>
      </div>
    </template>

    <!-- ============ 调班审批 ============ -->
    <template v-else-if="tab === 'swaps'">
      <div class="card swapform">
        <h3>🙋 员工发起调班（同岗位协作）</h3>
        <select v-model="swapForm.schedule_id">
          <option value="" disabled>选择我的未开始班次</option>
          <option v-for="s in swappableSchedules" :key="s.id" :value="s.id">
            第{{ s.day }}天 {{ s.staff_name }} · {{ s.shift_name }}（{{ s.role }}）
          </option>
        </select>
        <select v-model="swapForm.target_staff_id">
          <option value="" disabled>换给同岗位同事</option>
          <option v-for="t in activeStaff.filter(x => {
            const sc = swappableSchedules.find(s => s.id === +swapForm.schedule_id)
            return sc && x.role === sc.role && x.id !== sc.staff_id
          })" :key="t.id" :value="t.id">{{ t.name }} · {{ t.role }}</option>
        </select>
        <input v-model="swapForm.reason" placeholder="调班原因（可选）" maxlength="50" />
        <button class="primary" @click="applySwap">提交申请</button>
        <span class="msg" :class="{ err: swapMsg && !swapMsg.includes('已提交') }">{{ swapMsg }}</span>
      </div>

      <div class="table card">
        <div class="thead"><span>单号</span><span>班次</span><span>申请人</span><span>换给</span><span>原因</span><span>状态</span><span>主管操作</span></div>
        <div class="trow" v-for="sw in store.shiftSwaps" :key="sw.id">
          <span><b>{{ sw.code }}</b></span>
          <span>第{{ sw.day }}天 · {{ sw.shift_name }}</span>
          <span>{{ sw.staff_name }}</span>
          <span>{{ sw.target_name }}</span>
          <span class="muted">{{ sw.reason || '—' }}</span>
          <span><i class="tag" :class="SWAP_META[sw.status]?.cls">{{ SWAP_META[sw.status]?.label }}</i><em v-if="sw.reviewer_name" class="muted"> {{ sw.reviewer_name }}</em></span>
          <span>
            <template v-if="sw.status === 'pending'">
              <button class="succ sm" @click="review(sw, true)">批准</button>
              <button class="danger sm" @click="review(sw, false)">驳回</button>
            </template>
            <button v-else-if="sw.status === 'pending'" class="ghost sm" @click="cancelSwapReq(sw)">撤销</button>
          </span>
        </div>
        <div class="muted empty" v-if="!store.shiftSwaps.length">暂无调班记录。</div>
      </div>
    </template>

    <!-- ============ 工时工资 ============ -->
    <template v-else-if="tab === 'payroll'">
      <div class="bar">
        <div class="days">
          <button class="daybtn" :class="{ on: payrollDay === 0 }" @click="payrollDay = 0"><b>全部</b></button>
          <button v-for="d in [store.clock.day - 1, store.clock.day, store.clock.day + 1]" :key="d"
                  class="daybtn" :class="{ on: payrollDay === d, past: d < store.clock.day }" @click="payrollDay = d">
            <em>第 {{ d }} 天</em>
          </button>
        </div>
        <span class="gm">合计实发 <b class="money neg">¥{{ payrollSum.toLocaleString() }}</b>（已逐笔进入「工资」财务科目）</span>
      </div>
      <div class="table card">
        <div class="thead phead"><span>单号</span><span>员工</span><span>归属日</span><span>类型</span><span>基本</span><span>加班费</span><span>夜班费</span><span>扣减</span><span>实发</span><span>备注</span></div>
        <div class="trow prow" v-for="p in payrollList" :key="p.id">
          <span><b>{{ p.code }}</b></span>
          <span>{{ p.staff_name }}<em class="muted"> {{ p.role }}</em></span>
          <span>第{{ p.day }}天</span>
          <span><i class="tag" :class="KIND_META[p.kind]?.cls">{{ KIND_META[p.kind]?.label || p.kind }}</i></span>
          <span class="money">¥{{ p.base_pay }}</span>
          <span class="ot" v-if="p.overtime_pay">¥{{ p.overtime_pay }}</span><span v-else class="muted">—</span>
          <span class="night" v-if="p.night_pay">¥{{ p.night_pay }}</span><span v-else class="muted">—</span>
          <span class="neg" v-if="p.deduction">-¥{{ p.deduction }}</span><span v-else class="muted">—</span>
          <span class="money neg"><b>¥{{ p.amount }}</b></span>
          <span class="muted note">{{ p.note }}</span>
        </div>
        <div class="muted empty" v-if="!payrollList.length">暂无结算记录，员工签退后按班次逐笔结算。</div>
      </div>
    </template>

    <!-- ============ 班次/结算配置 ============ -->
    <template v-else>
      <div class="card cfg">
        <h3>⚙️ 工时结算参数（运营主管）</h3>
        <label>加班工资倍率 <input type="number" step="0.1" v-model.number="cfgForm.overtimeRate" /> <em>× 时薪（1~3）</em></label>
        <label>待工补贴比例 <input type="number" step="0.05" v-model.number="cfgForm.standbyRate" /> <em>× 日薪（无排班日）</em></label>
        <label>签到宽限（分钟） <input type="number" v-model.number="cfgForm.lateGrace" /></label>
        <label>迟到扣薪上限 <input type="number" step="0.05" v-model.number="cfgForm.lateDeductCap" /> <em>× 日薪</em></label>
        <label>夜班津贴（元/工时） <input type="number" v-model.number="cfgForm.nightAllowance" /></label>
        <button class="primary" @click="saveCfg">保存参数</button>
        <span class="msg" :class="{ err: cfgMsg && !cfgMsg.includes('已保存') }">{{ cfgMsg }}</span>
      </div>

      <div class="table card">
        <div class="thead"><span>班次</span><span>上班</span><span>下班</span><span>跨日</span><span>夜班工时</span><span>启用</span></div>
        <div class="trow" v-for="sh in store.shiftTypes" :key="sh.id">
          <span><b>{{ sh.name }}</b></span>
          <span><input type="number" min="0" max="23" :value="sh.start_hour" @change="saveShift(sh, { start_hour: +$event.target.value })" class="tiny" />:00</span>
          <span><input type="number" min="0" max="23" :value="sh.end_hour" @change="saveShift(sh, { end_hour: +$event.target.value })" class="tiny" />:00</span>
          <span>{{ sh.end_hour < sh.start_hour ? '是' : '否' }}</span>
          <span><input type="number" step="0.5" :value="sh.night_hours" :disabled="sh.end_hour >= sh.start_hour" @change="saveShift(sh, { night_hours: +$event.target.value })" class="tiny" /> h</span>
          <span><button class="ghost sm" @click="saveShift(sh, { active: !sh.active })">{{ sh.active ? '停用' : '启用' }}</button></span>
        </div>
      </div>

      <div class="card logs">
        <h3>📜 排班/考勤时间线</h3>
        <div v-for="l in [...store.scheduleLogs].reverse().slice(0, 40)" :key="l.id" class="log">
          <span class="muted">D{{ l.day }} {{ String(l.hour).padStart(2, '0') }}:00</span>
          <i class="tag">{{ LOG_LABEL[l.action] || l.action }}</i>
          <span>{{ l.note }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sched { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px; }
.stat span { font-size: 22px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.stat.alert { border-color: rgba(255,107,107,.5); }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button.on { background: rgba(255,107,107,.18); border-color: var(--accent); color: var(--accent); }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.days { display: flex; gap: 8px; }
.daybtn { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 16px; position: relative; min-width: 86px; }
.daybtn em { font-style: normal; font-size: 11px; color: var(--muted); }
.daybtn b { font-size: 13px; }
.daybtn.on { border-color: var(--accent); background: rgba(255,107,107,.15); color: var(--accent); }
.daybtn.past { opacity: .7; }
.miss-dot { position: absolute; top: -6px; right: -6px; background: var(--red); color: #fff; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; font-style: normal; line-height: 18px; }
.gm { font-size: 13px; color: var(--muted); }
.coverage .cov { display: flex; gap: 12px; align-items: center; padding: 6px 0; font-size: 13px; border-bottom: 1px dashed var(--border); }
.coverage .cov:last-child { border-bottom: none; }
.coverage .ok { color: var(--green); font-style: normal; }
.coverage .gap { color: var(--red); }
.cov em { font-style: normal; font-size: 12px; margin-left: auto; }
.newshift, .swapform, .kiosk, .cfg { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.newshift h3, .swapform h3, .kiosk h3, .cfg h3 { width: 100%; }
.msg { font-size: 12px; color: var(--green); }
.msg.err { color: var(--red); }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: 1fr 1fr 1.2fr 1.3fr 1.2fr .8fr 1.3fr 1fr; gap: 8px; align-items: center; padding: 9px 12px; font-size: 13px; min-width: 980px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.phead, .prow { grid-template-columns: .8fr 1.1fr .7fr .9fr .7fr .7fr .7fr .7fr .8fr 2fr; min-width: 1050px; }
.time { font-size: 12px; color: var(--muted); white-space: nowrap; }
.tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 20px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); margin: 1px 2px; }
.tag.st-sched { color: var(--blue); border-color: rgba(102,166,255,.4); }
.tag.st-on { color: var(--green); border-color: rgba(109,213,160,.45); background: rgba(109,213,160,.1); }
.tag.st-done { color: var(--muted); }
.tag.st-miss, .tag.bad { color: var(--red); border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.1); }
.tag.st-cancel { opacity: .6; }
.tag.warn { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.ot { color: var(--accent2); font-size: 12px; }
.night { color: var(--purple); font-size: 12px; }
.neg { color: var(--red); }
.ok { color: var(--green); }
button.sm { padding: 4px 10px; font-size: 12px; }
select, input.tiny { max-width: 100%; }
input.tiny { width: 60px; padding: 4px 6px; text-align: center; }
.empty { padding: 16px; text-align: center; }
.kiosk .tip { width: 100%; font-size: 12px; }
.myshifts { width: 100%; display: flex; gap: 10px; flex-wrap: wrap; }
.ms { padding: 10px 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.cfg label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.cfg label em { font-style: normal; color: var(--muted); font-size: 11px; }
.cfg input { width: 90px; }
.logs .log { display: flex; gap: 10px; align-items: center; font-size: 12px; padding: 5px 0; border-bottom: 1px dashed var(--border); }
.logs .log span:first-child { width: 92px; flex-shrink: 0; font-size: 11px; }
.prow .note { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
