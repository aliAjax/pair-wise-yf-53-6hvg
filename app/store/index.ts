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
export type TrainStatus = 'preparing' | 'frozen' | 'queued' | 'rolled-back';
export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: TrainStatus;
  /** 当前冻结或排队所在的发布窗口 */
  windowId?: string;
  /** 最近一次冻结被拒时看到的被占用仓库（先写入生效，后到者可见） */
  lastConflict?: string[];
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
}
export interface Receipt {
  id: string;
  repo: string;
  windowId: string;
  trainId: string;
  at: string;
}
export interface ReleaseWindow {
  id: string;
  name: string;
  /** 窗口容量：可同时冻结的列车数 */
  capacity: number;
  /** 排队候补水名额的列车 id（先进先出） */
  queue: string[];
}
interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
  windows: ReleaseWindow[];
  receipts: Receipt[];
  receiptSeq: number;
}

const initial: TrainState = {
  activeId: 'train-101',
  windows: [{ id: 'win-10', name: '2026-10 发布窗口', capacity: 2, queue: [] }],
  receipts: [],
  receiptSeq: 0,
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

let auditSeq = 0;
function makeAuditId() { return `a-${Date.now()}-${auditSeq++}`; }
function nowText() { return new Date().toLocaleTimeString(); }
function pushAudit(train: ReleaseTrain, text: string) {
  train.audit.unshift({ id: makeAuditId(), at: nowText(), text });
}

/** 窗口内当前冻结占用的列车 */
function frozenInWindow(state: TrainState, windowId: string): ReleaseTrain[] {
  return state.trains.filter((item) => item.windowId === windowId && item.status === 'frozen');
}

/** 窗口内已被其他冻结列车占用的仓库 → 占用列车 id */
function occupiedRepos(state: TrainState, windowId: string, excludeTrainId?: string): Map<string, string> {
  const occupied = new Map<string, string>();
  for (const train of frozenInWindow(state, windowId)) {
    if (train.id === excludeTrainId) continue;
    for (const gate of train.gates) occupied.set(gate.repository, train.id);
  }
  return occupied;
}

/** 空出的窗口名额让排队的列车补上；补位前同样校验仓库占用冲突 */
function promoteQueue(state: TrainState, windowId: string, skip: Set<string> = new Set()) {
  const win = state.windows.find((item) => item.id === windowId);
  if (!win) return;
  while (win.queue.length > 0 && frozenInWindow(state, windowId).length < win.capacity) {
    const headId = win.queue[0];
    if (skip.has(headId)) { win.queue.shift(); continue; }
    const train = state.trains.find((item) => item.id === headId);
    if (!train) { win.queue.shift(); continue; }
    const occupied = occupiedRepos(state, windowId, train.id);
    const conflict = train.gates.map((gate) => gate.repository).filter((repo) => occupied.has(repo));
    if (conflict.length) {
      pushAudit(train, `排队补位暂缓：窗口 ${win.name} 中仓库 ${conflict.join('、')} 已被占用，继续等待`);
      break;
    }
    win.queue.shift();
    train.status = 'frozen';
    train.windowId = windowId;
    train.lastConflict = undefined;
    pushAudit(train, `窗口 ${win.name} 名额空出，排队补位冻结，占用仓库 ${train.gates.map((gate) => gate.repository).join('、')}`);
  }
}

/** 放出列车在窗口中的占位（移出排队 / 释放名额 / 排队补位） */
function releaseWindow(state: TrainState, train: ReleaseTrain, skip: Set<string> = new Set()) {
  const windowId = train.windowId;
  if (!windowId) return;
  const win = state.windows.find((item) => item.id === windowId);
  if (win) win.queue = win.queue.filter((id) => id !== train.id);
  train.windowId = undefined;
  train.status = 'preparing';
  train.lastConflict = undefined;
  if (win) promoteQueue(state, windowId, skip);
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({ id, ...action.payload, status: 'preparing', gates: [], blockers: [], audit: [{ id: makeAuditId(), at: nowText(), text: '创建发布列车' }] });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      pushAudit(train, `${gate.repository} 门禁由发布负责人确认`);
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      pushAudit(train, `阻断项已关闭：${blocker.title}`);
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      pushAudit(train, `调整 ${moved.repository} 的发布顺序`);
    },
    createWindow(state, action: PayloadAction<{ name: string; capacity: number }>) {
      state.windows.push({ id: `win-${Date.now()}`, ...action.payload, queue: [] });
    },
    /** 冻结入窗：容量内直接冻结占住仓库，容量外排队；同窗口仓库已被占则拒绝（先写入生效） */
    freezeTrain(state, action: PayloadAction<{ trainId: string; windowId: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      const win = state.windows.find((item) => item.id === action.payload.windowId);
      if (!train || !win) return;
      if (train.windowId === win.id && train.status === 'frozen') return;
      if (train.windowId && train.windowId !== win.id) {
        const prev = state.windows.find((item) => item.id === train.windowId);
        releaseWindow(state, train);
        pushAudit(train, `转至窗口 ${win.name}，退出原窗口 ${prev?.name ?? ''}`);
      }
      const occupied = occupiedRepos(state, win.id, train.id);
      const conflict = train.gates.map((gate) => gate.repository).filter((repo) => occupied.has(repo));
      if (conflict.length) {
        train.lastConflict = conflict;
        pushAudit(train, `冻结被拒：窗口 ${win.name} 中仓库 ${conflict.join('、')} 已被其他列车占用（先写入生效，后到者看到被占用仓库）`);
        return;
      }
      train.lastConflict = undefined;
      const frozenCount = frozenInWindow(state, win.id).length;
      if (frozenCount < win.capacity) {
        win.queue = win.queue.filter((id) => id !== train.id);
        train.status = 'frozen';
        train.windowId = win.id;
        pushAudit(train, `冻结进入窗口 ${win.name}，占用仓库 ${train.gates.map((gate) => gate.repository).join('、') || '（无仓库）'}`);
      } else {
        if (!win.queue.includes(train.id)) win.queue.push(train.id);
        train.status = 'queued';
        train.windowId = win.id;
        pushAudit(train, `窗口 ${win.name} 已满（${win.capacity} 个名额），排队等候补位`);
      }
    },
    /** 回滚：放出窗口占位，名额让排队列车补上 */
    rollbackTrain(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === action.payload);
      if (!train) return;
      const win = train.windowId ? state.windows.find((item) => item.id === train.windowId) : undefined;
      releaseWindow(state, train);
      train.status = 'rolled-back';
      pushAudit(train, `标记回滚，放出窗口 ${win?.name ?? ''} 占位`);
    },
    /** 退出：放出窗口占位，回到准备状态 */
    leaveWindow(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === action.payload);
      if (!train) return;
      const win = train.windowId ? state.windows.find((item) => item.id === train.windowId) : undefined;
      releaseWindow(state, train);
      pushAudit(train, `退出窗口 ${win?.name ?? ''}，放出占位`);
    },
    /**
     * 登记远端回执：只补没有回执的仓库；已登记的仓库沿用首次回执编号，不重复编号。
     * registered 为远端本次实际登记成功的仓库，failed 为远端部分成功后未登记的仓库。
     */
    recordReceipts(state, action: PayloadAction<{ windowId: string; trainId: string; registered: string[]; failed: string[] }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      const win = state.windows.find((item) => item.id === action.payload.windowId);
      if (!train || !win) return;
      for (const repo of action.payload.registered) {
        const existing = state.receipts.find((item) => item.windowId === action.payload.windowId && item.repo === repo);
        if (existing) {
          pushAudit(train, `仓库 ${repo} 远端回执沿用首次编号 ${existing.id}`);
          continue;
        }
        state.receiptSeq += 1;
        const id = `RCP-${String(state.receiptSeq).padStart(4, '0')}`;
        state.receipts.push({ id, repo, windowId: action.payload.windowId, trainId: train.id, at: nowText() });
        pushAudit(train, `仓库 ${repo} 远端登记成功，回执 ${id}`);
      }
      for (const repo of action.payload.failed) {
        pushAudit(train, `仓库 ${repo} 远端登记未成功，保留占位待下次补登`);
      }
    },
    /** 上游版本变更：依赖它的门禁确认立即作废，相关列车退出窗口放出占位，排队名额由排队列车补上 */
    changeUpstream(state, action: PayloadAction<{ pkg: string; version: string }>) {
      const { pkg, version } = action.payload;
      const affected = new Set<string>();
      for (const train of state.trains) {
        let touched = false;
        for (const gate of train.gates) {
          const match = /^([^@]+)@/.exec(gate.dependency);
          if (match && match[1] === pkg) {
            gate.dependency = `${pkg}@${version}`;
            if (gate.status === 'confirmed') {
              gate.status = 'pending';
              pushAudit(train, `上游 ${pkg} 升级至 ${version}，仓库 ${gate.repository} 的门禁确认作废`);
            }
            touched = true;
          }
        }
        if (touched && train.windowId) affected.add(train.id);
      }
      for (const id of affected) {
        const train = state.trains.find((item) => item.id === id);
        if (!train) continue;
        const win = state.windows.find((item) => item.id === train.windowId);
        releaseWindow(state, train, affected);
        pushAudit(train, `因上游 ${pkg} 变更，退出窗口 ${win?.name ?? ''} 并放出占位`);
      }
      for (const win of state.windows) promoteQueue(state, win.id);
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
    }),
    /** 远端登记：模拟部分成功（约 70% 仓库登记成功），调用方只传没有回执的仓库 */
    registerRepos: builder.mutation<{ registered: string[]; failed: string[] }, { windowId: string; trainId: string; repos: string[] }>({
      queryFn: async ({ repos }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const registered: string[] = [];
        const failed: string[] = [];
        for (const repo of repos) {
          if (Math.random() < 0.7) registered.push(repo);
          else failed.push(repo);
        }
        return { data: { registered, failed } };
      }
    })
  })
});

export const { useGetTrainHealthQuery, useRegisterReposMutation } = releaseApi;
export const {
  activateTrain,
  changeUpstream,
  confirmGate,
  createTrain,
  createWindow,
  freezeTrain,
  leaveWindow,
  recordReceipts,
  reorderGates,
  replaceState,
  resolveBlocker,
  rollbackTrain
} = trainSlice.actions;

const STORAGE_KEY = 'yf53-release-state';
function loadState(): TrainState {
  if (typeof window === 'undefined') return initial;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return initial;
    const parsed = JSON.parse(saved) as Partial<TrainState>;
    if (!parsed.windows || !parsed.trains) return initial;
    return { ...initial, ...parsed } as TrainState;
  } catch {
    return initial;
  }
}

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  store.dispatch(replaceState(loadState()));
  store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
