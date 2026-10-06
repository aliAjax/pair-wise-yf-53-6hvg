import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
}
export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
}

/** 窗口中的一个占位（或排队条目）：某列车的某个仓库门禁占住的名额 */
export interface WindowSlot {
  repo: string;
  trainId: string;
  gateId: string;
  at: string;
}
export interface ReleaseWindow {
  id: string;
  name: string;
  capacity: number;
  slots: WindowSlot[];
  queue: WindowSlot[];
  frozenBy: string | null;
  frozenAt: string | null;
}
/** 远端登记回执：key 为 `窗口:仓库`，首次登记后编号固定，重复登记沿用 */
export interface Receipt {
  key: string;
  windowId: string;
  repo: string;
  number: string;
  at: string;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
  windows: ReleaseWindow[];
  receipts: Receipt[];
  receiptSeq: number;
  /** 每个 `窗口:仓库` 的登记尝试次数，用于模拟远端偶发失败 */
  registerAttempts: Record<string, number>;
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [
    {
      id: 'train-101',
      name: 'Sept 2026 发布列车',
      freezeAt: '2026-09-30 18:00',
      status: 'preparing',
      gates: [
        { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
        { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
        { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'confirmed', version: '1.9.4' }
      ],
      blockers: [
        { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
        { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
      ],
      audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
    },
    {
      id: 'train-202',
      name: 'Oct 2026 补丁列车',
      freezeAt: '2026-10-09 18:00',
      status: 'preparing',
      gates: [
        { id: 'g201', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'confirmed', version: '2.12.1' },
        { id: 'g202', repository: 'search', owner: '吴敏', dependency: 'shared-ui@4.2', status: 'confirmed', version: '6.1.0' },
        { id: 'g203', repository: 'portal', owner: '吴敏', dependency: 'web-console@4.8', status: 'confirmed', version: '1.4.0' }
      ],
      blockers: [{ id: 'b201', title: 'search 索引重建脚本未评审', severity: 'warning', resolved: false }],
      audit: [{ id: 'a201', at: '10:05', text: '创建补丁列车并关联 3 个仓库' }]
    }
  ],
  windows: [
    {
      id: 'win-a',
      name: 'W41 发布窗口（10/06-10/10）',
      capacity: 2,
      slots: [
        { repo: 'web-console', trainId: 'train-101', gateId: 'g1', at: '09:30' },
        { repo: 'gateway', trainId: 'train-101', gateId: 'g2', at: '09:31' }
      ],
      queue: [{ repo: 'data-sync', trainId: 'train-101', gateId: 'g3', at: '09:32' }],
      frozenBy: null,
      frozenAt: null
    },
    {
      id: 'win-b',
      name: 'W42 发布窗口（10/13-10/17）',
      capacity: 3,
      slots: [{ repo: 'portal', trainId: 'train-202', gateId: 'g203', at: '10:06' }],
      queue: [],
      frozenBy: null,
      frozenAt: null
    }
  ],
  // 远端登记只成功一半的现场：web-console 已有回执，gateway 还欠着
  receipts: [{ key: 'win-a:web-console', windowId: 'win-a', repo: 'web-console', number: 'RCP-0000', at: '09:40' }],
  receiptSeq: 1,
  registerAttempts: {}
};

let auditSeq = 0;
function stamp() {
  return new Date().toLocaleTimeString();
}
function audit(train: ReleaseTrain | undefined, text: string) {
  if (!train) return;
  train.audit.unshift({ id: `a-${Date.now()}-${auditSeq++}`, at: stamp(), text });
}
function findTrain(state: TrainState, id: string) {
  return state.trains.find((item) => item.id === id);
}
function activeTrain(state: TrainState) {
  return findTrain(state, state.activeId);
}
function receiptKey(windowId: string, repo: string) {
  return `${windowId}:${repo}`;
}

/** 窗口空出名额后，按排队顺序补位 */
function promoteQueue(state: TrainState, window: ReleaseWindow) {
  while (window.slots.length < window.capacity && window.queue.length > 0) {
    const next = window.queue.shift()!;
    window.slots.push({ ...next, at: stamp() });
    audit(findTrain(state, next.trainId), `窗口 ${window.name} 空出名额，${next.repo} 排队补位成功`);
  }
}

/** 释放某列车在（某个或全部）窗口的占位与排队，并让队列补位 */
function releaseTrainFromWindows(state: TrainState, trainId: string, reason: string, onlyWindowId?: string) {
  const train = findTrain(state, trainId);
  for (const window of state.windows) {
    if (onlyWindowId && window.id !== onlyWindowId) continue;
    const released = window.slots.filter((slot) => slot.trainId === trainId);
    const wasQueued = window.queue.some((entry) => entry.trainId === trainId);
    window.slots = window.slots.filter((slot) => slot.trainId !== trainId);
    window.queue = window.queue.filter((entry) => entry.trainId !== trainId);
    if (window.frozenBy === trainId) {
      window.frozenBy = null;
      window.frozenAt = null;
    }
    for (const slot of released) audit(train, `${slot.repo} ${reason}，释放窗口 ${window.name} 占位`);
    if (released.length > 0 || wasQueued) promoteQueue(state, window);
  }
}

/** 确认作废的仓库门禁释放其窗口占位 */
function releaseGateSlots(state: TrainState, trainId: string, gateId: string, reason: string) {
  const train = findTrain(state, trainId);
  for (const window of state.windows) {
    const released = window.slots.filter((slot) => slot.trainId === trainId && slot.gateId === gateId);
    if (released.length === 0) continue;
    window.slots = window.slots.filter((slot) => !(slot.trainId === trainId && slot.gateId === gateId));
    if (window.frozenBy === trainId && !window.slots.some((slot) => slot.trainId === trainId)) {
      window.frozenBy = null;
      window.frozenAt = null;
    }
    for (const slot of released) audit(train, `${slot.repo} ${reason}，释放窗口 ${window.name} 占位`);
    promoteQueue(state, window);
  }
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({ id, ...action.payload, status: 'preparing', gates: [], blockers: [], audit: [{ id: `a-${Date.now()}`, at: stamp(), text: '创建发布列车' }] });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = activeTrain(state);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      audit(train, `${gate.repository} 门禁由发布负责人确认`);
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = activeTrain(state);
      if (!train) return;
      train.status = action.payload;
      audit(train, `状态调整为 ${action.payload}`);
      if (action.payload === 'rolled-back') releaseTrainFromWindows(state, train.id, '回滚');
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = activeTrain(state);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      audit(train, `阻断项已关闭：${blocker.title}`);
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = activeTrain(state);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      audit(train, `调整 ${moved.repository} 的发布顺序`);
    },
    /** 当前列车的一个仓库门禁申请窗口名额：已被别车占用则拒绝，窗口满了则排队 */
    requestSlot(state, action: PayloadAction<{ windowId: string; gateId: string }>) {
      const train = activeTrain(state);
      const window = state.windows.find((item) => item.id === action.payload.windowId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !window || !gate) return;
      const repo = gate.repository;
      if (window.slots.some((slot) => slot.repo === repo && slot.trainId === train.id)) return;
      if (window.queue.some((entry) => entry.repo === repo && entry.trainId === train.id)) return;
      const holder = window.slots.find((slot) => slot.repo === repo);
      if (holder) {
        const holderTrain = findTrain(state, holder.trainId);
        audit(train, `仓库 ${repo} 在窗口 ${window.name} 已被「${holderTrain?.name ?? holder.trainId}」占用，本次占位被拒绝`);
        return;
      }
      if (window.slots.length < window.capacity) {
        window.slots.push({ repo, trainId: train.id, gateId: gate.id, at: stamp() });
        audit(train, `${repo} 占用窗口 ${window.name} 名额（${window.slots.length}/${window.capacity}）`);
      } else {
        window.queue.push({ repo, trainId: train.id, gateId: gate.id, at: stamp() });
        audit(train, `窗口 ${window.name} 已满，${repo} 进入排队（第 ${window.queue.length} 位）`);
      }
    },
    /** 提交窗口冻结：先写入的生效，后到者看到被占用的仓库 */
    submitFreeze(state, action: PayloadAction<{ windowId: string }>) {
      const train = activeTrain(state);
      const window = state.windows.find((item) => item.id === action.payload.windowId);
      if (!train || !window) return;
      if (window.frozenBy && window.frozenBy !== train.id) {
        const holder = findTrain(state, window.frozenBy);
        const occupied = window.slots.filter((slot) => slot.trainId !== train.id).map((slot) => slot.repo);
        audit(train, `冻结提交被拒绝：窗口 ${window.name} 已被「${holder?.name ?? window.frozenBy}」先写入冻结` + (occupied.length > 0 ? `，被占用仓库：${occupied.join('、')}` : ''));
        return;
      }
      if (!window.frozenBy) {
        window.frozenBy = train.id;
        window.frozenAt = stamp();
        audit(train, `窗口 ${window.name} 冻结写入成功（先先生效），占用 ${window.slots.length}/${window.capacity} 个名额`);
      }
      train.status = 'frozen';
    },
    /** 当前列车退出窗口：放出占位与排队名额 */
    exitWindow(state, action: PayloadAction<{ windowId: string }>) {
      const train = activeTrain(state);
      if (!train) return;
      releaseTrainFromWindows(state, train.id, '退出窗口', action.payload.windowId);
    },
    /** 上游版本变更：依赖它的确认立即作废，作废确认占住的窗口名额放出给队列 */
    changeGateVersion(state, action: PayloadAction<{ gateId: string; version: string }>) {
      const train = activeTrain(state);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      const previous = gate.version;
      gate.version = action.payload.version;
      audit(train, `${gate.repository} 上游版本 ${previous} → ${gate.version}`);
      const invalidated: Array<{ trainId: string; gate: RepositoryGate }> = [];
      if (gate.status === 'confirmed') {
        gate.status = 'pending';
        invalidated.push({ trainId: train.id, gate });
        audit(train, `${gate.repository} 版本已变，原确认作废，需重新确认`);
      }
      for (const other of state.trains) {
        for (const dependent of other.gates) {
          if (dependent.id === gate.id && other.id === train.id) continue;
          const depRepo = dependent.dependency.split('@')[0];
          if (depRepo === gate.repository && dependent.status === 'confirmed') {
            dependent.status = 'pending';
            invalidated.push({ trainId: other.id, gate: dependent });
            audit(other, `上游 ${gate.repository} 版本变更为 ${gate.version}，${dependent.repository} 的确认立即作废`);
          }
        }
      }
      for (const item of invalidated) releaseGateSlots(state, item.trainId, item.gate.id, '确认作废');
    },
    /**
     * 远端登记：只补没有回执的仓库；已登记的回执保留，编号沿用首次。
     * 模拟远端偶发失败——奇数长度仓库首次登记失败，再次补登成功。
     */
    registerRemote(state, action: PayloadAction<{ windowId: string }>) {
      const window = state.windows.find((item) => item.id === action.payload.windowId);
      if (!window) return;
      for (const slot of window.slots) {
        const key = receiptKey(window.id, slot.repo);
        if (state.receipts.some((receipt) => receipt.key === key)) continue;
        const attempt = (state.registerAttempts[key] ?? 0) + 1;
        state.registerAttempts[key] = attempt;
        const train = findTrain(state, slot.trainId);
        const ok = slot.repo.length % 2 === 0 || attempt >= 2;
        if (ok) {
          const number = `RCP-${String(state.receiptSeq++).padStart(4, '0')}`;
          state.receipts.push({ key, windowId: window.id, repo: slot.repo, number, at: stamp() });
          audit(train, `${slot.repo} 远端登记成功，回执 ${number}`);
        } else {
          audit(train, `${slot.repo} 远端登记失败（部分成功），已登记的回执保留，待下次补登`);
        }
      }
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  changeGateVersion,
  confirmGate,
  createTrain,
  exitWindow,
  registerRemote,
  reorderGates,
  replaceState,
  requestSlot,
  resolveBlocker,
  setFreeze,
  submitFreeze
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state-v2');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  store.subscribe(() => localStorage.setItem('yf53-release-state-v2', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
